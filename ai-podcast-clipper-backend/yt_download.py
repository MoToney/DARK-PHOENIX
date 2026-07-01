import os
import shutil

import boto3
import modal
import yt_dlp
from botocore.exceptions import ClientError
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel


class DownloadYouTubeVideoRequest(BaseModel):
    url: str
    uploadedFileId: str
    userId: str
    simulate: bool = False


SAMPLE_VIDEO_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw"

LOCAL_TEST_VIDEO = "./sample.mp4"
SAMPLE_VIDEO_PATH = "/opt/sample.mp4"

download_image = (
    modal.Image.debian_slim()
    .apt_install("ffmpeg", "curl", "unzip")
    .run_commands(
        "curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh",
        "deno --version",
        f"mkdir -p /opt/sample && curl -fsSL {SAMPLE_VIDEO_URL} -o {SAMPLE_VIDEO_PATH}",
    )
    .pip_install(
        "boto3",
        "yt-dlp",
        "fastapi",
        "pydantic",
    )
    .add_local_file(LOCAL_TEST_VIDEO, remote_path=SAMPLE_VIDEO_PATH)
)

app = modal.App("yt-downloader")

volume = modal.Volume.from_name(
    "yt-downloader-model-cache", create_if_missing=True
)

mount_path = "/root/.cache/torch"

auth_scheme = HTTPBearer()


def simulated_download() -> str:
    dest = "/tmp/simulated_download.mp4"
    shutil.copyfile(SAMPLE_VIDEO_PATH, dest)
    return dest


def download(url: str, low_quality=True) -> str:
    output_template = "/tmp/%(id)s.%(ext)s"
    deno_path = os.popen("which deno").read().strip()

    ydl_opts = {
        "outtmpl": output_template,
        "nocheckcertificate": True,
        "quiet": False,
        "js_runtimes": {"deno": {"path": deno_path}},
        "remote_components": {"ejs:github"},
    }

    if low_quality:
        ydl_opts["format"] = "worstvideo+worstaudio/worst"
    else:
        ydl_opts["format"] = "bestvideo+bestaudio/best"

    proxy_url = os.environ.get("PROXY_URL")
    if proxy_url:
        ydl_opts["proxy"] = proxy_url

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            video_path = ydl.prepare_filename(info)
    except Exception as e:
        raise RuntimeError(f"yt-dlp blocked or failed: {e}") from e

    return video_path


def get_cookie_path():
    COOKIE_PATH = "/tmp/cookies.txt"

    cookie_content = os.environ["COOKIES"]
    with open(COOKIE_PATH, "w") as f:
        f.write(cookie_content)


def check():
    output_template = "/tmp/%(title)s.%(ext)s"
    deno_path = os.popen("which deno").read().strip()

    ydl_opts = {
        "outtmpl": output_template,
        "nocheckcertificate": True,
        "quiet": False,
        "js_runtimes": {"deno": {"path": deno_path}},
        "remote_components": {"ejs:github"},
    }

    proxy_url = os.environ.get("PROXY_URL")
    if proxy_url:
        ydl_opts["proxy"] = proxy_url

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(SAMPLE_VIDEO_URL, download=False)

            return {
                "success": True,
                "title": info.get("title"),
                "id": info.get("id"),
                "uploader": info.get("uploader"),
                "formats_count": len(info.get("formats", [])),
            }

    except Exception as e:
        raise RuntimeError(f"yt-dlp blocked or failed: {e}") from e


@app.cls(
    image=download_image, timeout=900, retries=0, scaledown_window=20,
    secrets=[modal.Secret.from_name("yt-cookies"), modal.Secret.from_name("ai-podcast-clipper-secret")],
    volumes={mount_path: volume},
)
class YouTubeDownloader:
    @modal.method()
    def test_download(self, url: str):
        print("Running on:", os.name)
        print("COOKIES exists:", "COOKIES" in os.environ)
        print("PROXY_URL exists:", "PROXY_URL" in os.environ)

        if "PROXY_URL" in os.environ:
            print("PROXY_URL:", os.environ["PROXY_URL"][:30] + "...")

        return download(url)

    @modal.method()
    def test_check(self):
        print("Running on:", os.name)
        print("COOKIES exists:", "COOKIES" in os.environ)
        print("PROXY_URL exists:", "PROXY_URL" in os.environ)

        if "PROXY_URL" in os.environ:
            print("PROXY_URL:", os.environ["PROXY_URL"][:30] + "...")

        print(yt_dlp.version.__version__)

        return check()

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
        else:
            try:
                video_path = download(request.url)
            except RuntimeError as e:
                raise HTTPException(status_code=502, detail=str(e))

        s3_key = f"{request.uploadedFileId}/original.mp4"
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


@app.local_entrypoint()
def main():
    import requests

    web_url = "https://motoney--yt-downloader-youtubedownloader-downlo-0fdce6-dev.modal.run"

    payload = {
        "url": SAMPLE_VIDEO_URL,
        "uploadedFileId": "1",
        "userId": "2",
        "simulate": True
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer UwnV0dN12dV6hkRfnNkI"
    }

    response = requests.post(web_url, json=payload,
                             headers=headers)
    response.raise_for_status()
    result = response.json()
    print(result)
