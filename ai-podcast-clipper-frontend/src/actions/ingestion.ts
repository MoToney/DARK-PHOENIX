"use server";

import {auth} from "~/server/auth";
import {inngest} from "~/inngest/client";
import {db} from "~/server/db";
import {spawn} from "child_process";
import path from "node:path";
import * as os from "node:os";
import {extractYouTubeId, validateYouTubeUrl} from "~/lib/youtube";
import {revalidatePath} from "next/cache";
import {SourceType} from "@prisma/client";


export async function downloadYouTubeVideo(url: string) {
    const session = await auth();
    if (!session?.user?.id) {
        throw new Error("Unauthorized");
    }


    validateYouTubeUrl(url);

    const uploadedFile = await db.uploadedFile.create({
        data: {
            userId: session.user.id,
            sourceType: SourceType.YOUTUBE,
            uploaded: false,
            status: "queued",
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
            simulate: "true"
        },
    });

    revalidatePath("/dashboard");

    return {
        success: true,
        uploadedFileId: uploadedFile.id
    };
}

