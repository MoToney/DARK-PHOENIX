export function extractYouTubeId(url: string): string | null {
    try {
        const parsed = new URL(url);

        if (parsed.hostname.includes("youtube.com")) {
            // handles /watch?v=, /shorts/, /embed/, /live/
            if (parsed.searchParams.has("v")) {
                return parsed.searchParams.get("v");
            }
            const regex = /^\/(shorts|embed|live)\/([^/?]+)/;
            const match = regex.exec(parsed.pathname);
            
            if (match) {
                return match[2] ?? null;
            }
            return null;
        }

        if (parsed.hostname === "youtu.be") {
            const id = parsed.pathname.replace("/", "");
            return id || null;
        }

        return null;
    } catch {
        return null;
    }
}

export function validateYouTubeUrl(
    url: string
): { valid: boolean; error?: string; videoId?: string } {
    if (!url) {
        return { valid: false, error: "URL is required" };
    }

    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        return { valid: false, error: "Invalid URL format" };
    }

    const isYouTube =
        parsed.hostname.includes("youtube.com") ||
        parsed.hostname === "youtu.be" ||
        parsed.hostname === "www.youtube.com";

    if (!isYouTube) {
        return { valid: false, error: "Only YouTube URLs are supported" };
    }

    const videoId = extractYouTubeId(url);

    if (!videoId) {
        return { valid: false, error: "Could not extract YouTube video ID" };
    }

    return { valid: true, videoId };
}