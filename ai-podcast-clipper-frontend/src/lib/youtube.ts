import ytdlp from "yt-dlp-exec";
import path from "node:path";
import * as os from "node:os";

export function extractYouTubeId(url: string): string | null {
    try {
        const parsed = new URL(url);

        if (parsed.hostname.includes("youtube.com")) {
            return parsed.searchParams.get("v");
        }

        if (parsed.hostname === "youtu.be") {
            return parsed.pathname.replace("/", "");
        }

        return null;
    } catch {
        return null;
    }
}

export function validateYouTubeUrl(url: string): { valid: boolean; error?: string } {
    if (!url) {
        return {valid: false, error: "URL is required"};
    }

    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        return {valid: false, error: "Invalid URL format"};
    }

    const isYouTube =
        parsed.hostname.includes("youtube.com") ||
        parsed.hostname === "youtu.be" ||
        parsed.hostname === "www.youtube.com";

    if (!isYouTube) {
        return {valid: false, error: "Only YouTube URLs are supported"};
    }

    const videoId = extractYouTubeId(url);

    if (!videoId) {
        return {valid: false, error: "Could not extract YouTube video ID"};
    }

    return {valid: true};
}