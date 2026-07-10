import os
import shutil
from typing import Any
import boto3
import modal
import yt_dlp
from botocore.exceptions import ClientError
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
import logging

class DownloadYouTubeVideoRequest(BaseModel):
    url: str
    uploadedFileId: str
    userId: str
    simulate: bool = False


SAMPLE_VIDEO_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
LOCAL_TEST_VIDEO = "./tesla.mp4"
SAMPLE_VIDEO_PATH = "/opt/tesla.mp4"

download_image = (
    modal.Image.debian_slim()
    .apt_install("ffmpeg", "curl", "unzip")
    .run_commands(
        "curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh",
        "deno --version",
    )
    .pip_install(
        "boto3",
        "yt-dlp",
        "fastapi",
        "pydantic",
    )
)

test_image = download_image.add_local_file(
    LOCAL_TEST_VIDEO, remote_path=SAMPLE_VIDEO_PATH
)

app = modal.App("yt-downloader")

volume = modal.Volume.from_name(
    "yt-downloader-model-cache", create_if_missing=True
)

mount_path = "/root/.cache/torch"

auth_scheme = HTTPBearer()

logger = logging.getLogger("yt-downloader")
logging.basicConfig(level=logging.INFO)


def simulated_download() -> str:
    dest = "/tmp/simulated_download.mp4"
    shutil.copyfile(SAMPLE_VIDEO_PATH, dest)
    return dest


def _get_format(duration: int) -> str:
    if duration < 10 * 60:
        return "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4]"

    if duration < 30 * 60:
        return "bv*[ext=mp4][height<=720]+ba[ext=m4a]/b[ext=mp4]"

    if duration < 60 * 60:
        return "bv*[ext=mp4][height<=480]+ba[ext=m4a]/b[ext=mp4]"

    if duration < 120 * 60:
        return "bv*[ext=mp4][height<=360]+ba[ext=m4a]/b[ext=mp4]"

    return "bv*[ext=mp4][height<=240]+ba[ext=m4a]/b[ext=mp4]"


def _build_ydl_opts(output_template):
    deno_path = os.popen("which deno").read().strip()

    opts = {
        "outtmpl": output_template,
        "nocheckcertificate": True,
        "quiet": False,
        "js_runtimes": {"deno": {"path": deno_path}},
        "remote_components": {"ejs:github"},
        "merge_output_format": "mp4",
    }

    proxy_url = os.environ.get("PROXY_URL")
    if proxy_url:
        opts["proxy"] = proxy_url

    return opts


def _extract_info(url: str, ydl_opts: dict, download: bool = False) -> dict:
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            return ydl.extract_info(url, download=download)
    except Exception as e:
        raise RuntimeError(f"yt-dlp blocked or failed: {e}") from e


def download(url: str) -> tuple[Any, dict]:
    output_template = "/tmp/%(id)s.%(ext)s"
    ydl_opts = _build_ydl_opts(output_template)

    info = _extract_info(url, ydl_opts, download=False)
    ydl_opts["format"] = _get_format(info["duration"])

    info = _extract_info(url, ydl_opts, download=True)

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        video_path = ydl.prepare_filename(info)

    return video_path, info


def check() -> dict:
    output_template = "/tmp/%(title)s.%(ext)s"
    ydl_opts = _build_ydl_opts(output_template)

    info = _extract_info(SAMPLE_VIDEO_URL, ydl_opts, download=False)

    return {
        "success": True,
        "title": info.get("title"),
        "id": info.get("id"),
        "uploader": info.get("uploader"),
        "formats_count": len(info.get("formats", [])),
    }


@app.cls(
    image=download_image, timeout=900, retries=0, scaledown_window=20,
    secrets=[modal.Secret.from_name("yt-cookies"), modal.Secret.from_name("ai-podcast-clipper-secret")],
    volumes={mount_path: volume},
)
class YouTubeDownloader:
    @modal.fastapi_endpoint(method="POST")
    def download_youtube_video(
            self,
            request: DownloadYouTubeVideoRequest,
            token: HTTPAuthorizationCredentials = Depends(auth_scheme),
    ):
        if token.credentials != os.environ["AUTH_TOKEN"]:
            raise HTTPException(status_code=401, detail="Unauthorized")

        if request.simulate:
            video_path = simulated_download()
            video_id = "simulated"
        else:
            try:
                video_path, info = download(request.url)
                video_id = info.get("id")
            except RuntimeError as e:
                raise HTTPException(status_code=502, detail=str(e))

        s3_key = f"{video_id}/original.mp4"
        s3_client = boto3.client("s3")

        try:
            s3_client.upload_file(video_path, os.environ["S3_BUCKET_NAME"], s3_key)
        except ClientError as e:
            raise HTTPException(status_code=502, detail=f"S3 upload failed: {e}")

        try:
            head = s3_client.head_object(Bucket=os.environ["S3_BUCKET_NAME"], Key=s3_key)
        except ClientError as e:
            raise HTTPException(status_code=502, detail=f"Upload verification failed: {e}")

        local_size = os.path.getsize(video_path)
        if head["ContentLength"] != local_size:
            raise HTTPException(
                status_code=502,
                detail=f"Size mismatch: local={local_size} s3={head['ContentLength']}"
            )

        return {
            "message": "download complete",
            "s3_key": s3_key,
            "simulated": request.simulate,
        }


@app.cls(
    image=test_image, timeout=900, retries=0, scaledown_window=20,
    secrets=[modal.Secret.from_name("yt-cookies"), modal.Secret.from_name("ai-podcast-clipper-secret")],
    volumes={mount_path: volume},
)
class YouTubeDownloaderTest:
    @modal.method()
    def test_download(self, url: str):
        logger.debug("Running on: %s", os.name)
        if "PROXY_URL" in os.environ:
            logger.debug("PROXY_URL prefix: %s...", os.environ["PROXY_URL"][:30])
        return download(url)

    @modal.method()
    def test_check(self):
        logger.debug("Running on: %s", os.name)
        if "PROXY_URL" in os.environ:
            logger.debug("PROXY_URL prefix: %s...", os.environ["PROXY_URL"][:30])
        logger.debug(yt_dlp.version.__version__)
        return check()


@app.local_entrypoint()
def main():
    YouTubeDownloaderTest().test_check.remote()
    YouTubeDownloaderTest().test_download.remote(SAMPLE_VIDEO_URL)
