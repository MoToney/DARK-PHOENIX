"use server";

import { auth } from "~/server/auth";
import { inngest } from "~/inngest/client";
import { db } from "~/server/db";
import { validateYouTubeUrl } from "~/lib/youtube";
import { revalidatePath } from "next/cache";
import { SourceType } from "@prisma/client";

export async function downloadYouTubeVideo(url: string) {
    const session = await auth();
    if (!session?.user?.id) {
        throw new Error("Unauthorized");
    }

    if (!session?.user?.email) {
      return new Response("Unauthorized", { status: 401 });
    }

    const user = await db.user.findUnique({
      where: {
        email: session.user.email,
      },
    });

    if (!user) {
      return new Response("User not found", { status: 404 });
    }

    if (!user.approved) {
      return new Response(
        "Your account is awaiting approval.",
        { status: 403 }
      );
    }


    const { valid, videoId } = validateYouTubeUrl(url);
    if (!valid || !videoId) {
        throw new Error("Invalid YouTube URL");
    }

    let title: string | null = null;
    try {
        const response = await fetch(
            `https://noembed.com/embed?url=${encodeURIComponent(url)}&format=json`
        );
        const data = (await response.json()) as { title?: string };

        title = data.title ?? null;
    } catch (error) {
        console.error("Error fetching data:", error);
    }

    const uploadedFile = await db.uploadedFile.create({
        data: {
            userId: session.user.id,
            sourceType: SourceType.YOUTUBE,
            uploaded: false,
            status: "downloading",
            sourceUrl: url,
            youtubeId: videoId,
            displayName: title,
        },
        select: {
            id: true,
            userId: true,
        },
    });

    await inngest.send({
        name: "download-youtube-video-events",
        data: {
            uploadedFileId: uploadedFile.id,
            userId: session.user.id,
            url,
            simulate: process.env.NODE_ENV !== "production"
        },
    });

    revalidatePath("/dashboard");

    return {
        success: true,
        uploadedFileId: uploadedFile.id
    };
}