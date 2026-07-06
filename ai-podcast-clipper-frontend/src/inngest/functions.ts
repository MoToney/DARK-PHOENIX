import {env} from "~/env";
import {inngest} from "./client";
import {db} from "~/server/db";
import {ListObjectsV2Command, S3Client} from "@aws-sdk/client-s3";


export const downloadYouTubeVideo = inngest.createFunction(
    {
        id: "download-youtube-video",
        retries: 1,
        concurrency: {
            limit: 1,
            key: "event.data.userId",
        },
    },
    {event: "download-youtube-video-events"},
    async ({event, step}) => {
        const {uploadedFileId, userId, url, simulate} = event.data as {
            uploadedFileId: string;
            userId: string;
            url: string;
            simulate: boolean;
        };

        try {
            const response = await step.fetch(env.DOWNLOAD_VIDEO_ENDPOINT, {
                method: "POST",
                body: JSON.stringify({
                    url,
                    uploadedFileId,
                    userId,
                    simulate,
                }),
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${env.PROCESS_VIDEO_ENDPOINT_AUTH}`,
                },
            });

            if (!response.ok) {
                throw new Error(`Modal returned ${response.status}`);
            }

            // Modal returns where it actually put the file in S3
            const { s3_key: s3Key } = (await response.json()) as { s3_key: string };

            if (!s3Key) {
                throw new Error("Modal response missing s3Key");
            }

            await step.run("mark-downloaded", async () => {
                await db.uploadedFile.update({
                    where: {id: uploadedFileId},
                    data: {uploaded: true, s3Key: s3Key, status: "downloaded"},
                });
            });

            // Correct event name — matches what processVideo listens for
            await step.sendEvent("trigger-processing", {
                name: "process-video-events",
                data: {uploadedFileId, userId},
            });
        } catch (error) {
            console.error(error);

            await db.uploadedFile.update({
                where: {id: uploadedFileId},
                data: {status: "download_failed"},
            });

            throw error;
        }
    }
);

export const processVideo = inngest.createFunction(
    {
        id: "process-video",
        retries: 1,
        concurrency: {
            limit: 1,
            key: "event.data.userId",
        },
    },
    {event: "process-video-events"},
    async ({event, step}) => {
        const {uploadedFileId} = event.data as {
            uploadedFileId: string;
            userId: string;
        };

        try {
            const {userId, credits, s3Key} = await step.run(
                "check-credits",
                async () => {
                    const uploadedFile = await db.uploadedFile.findUniqueOrThrow({
                        where: {
                            id: uploadedFileId,
                        },
                        select: {
                            user: {
                                select: {
                                    id: true,
                                    credits: true,
                                },
                            },
                            s3Key: true,
                        },
                    });

                    return {
                        userId: uploadedFile.user.id,
                        credits: uploadedFile.user.credits,
                        s3Key: uploadedFile.s3Key,
                    };
                },
            );

            if (credits > 0) {
                await step.run("set-status-processing", async () => {
                    await db.uploadedFile.update({
                        where: {
                            id: uploadedFileId,
                        },
                        data: {
                            status: "processing",
                        },
                    });
                });

                await step.fetch(env.PROCESS_VIDEO_ENDPOINT, {
                    method: "POST",
                    body: JSON.stringify({s3_key: s3Key}),
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${env.PROCESS_VIDEO_ENDPOINT_AUTH}`,
                    },
                });

                const {clipsFound} = await step.run(
                    "create-clips-in-db",
                    async () => {
                        if (!s3Key) throw new Error("Missing s3Key");

                        const folderPrefix = s3Key.split("/")[0]!;

                        const allKeys = await listS3ObjectsByPrefix(folderPrefix);

                        const clipKeys = allKeys.filter(
                            (key): key is string =>
                                key !== undefined && !key.endsWith("original.mp4"),
                        );

                        if (clipKeys.length > 0) {
                            await db.clip.createMany({
                                data: clipKeys.map((clipKey) => ({
                                    s3Key: clipKey,
                                    uploadedFileId,
                                    userId,
                                })),
                            });
                        }

                        return {clipsFound: clipKeys.length};
                    },
                );

                await step.run("deduct-credits", async () => {
                    await db.user.update({
                        where: {
                            id: userId,
                        },
                        data: {
                            credits: {
                                decrement: Math.min(credits, clipsFound),
                            },
                        },
                    });
                });

                await step.run("set-status-processed", async () => {
                    await db.uploadedFile.update({
                        where: {
                            id: uploadedFileId,
                        },
                        data: {
                            status: "processed",
                        },
                    });
                });
            } else {
                await step.run("set-status-no-credits", async () => {
                    await db.uploadedFile.update({
                        where: {
                            id: uploadedFileId,
                        },
                        data: {
                            status: "no credits",
                        },
                    });
                });
            }
        } catch (error: unknown) {
            await db.uploadedFile.update({
                where: {
                    id: uploadedFileId,
                },
                data: {
                    status: "failed",
                },
            });
        }
    },
);

async function listS3ObjectsByPrefix(prefix: string) {
    const s3Client = new S3Client({
        region: env.AWS_REGION,
        credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        },
    });

    const listCommand = new ListObjectsV2Command({
        Bucket: env.S3_BUCKET_NAME,
        Prefix: prefix,
    });

    const response = await s3Client.send(listCommand);
    return response.Contents?.map((item) => item.Key).filter(Boolean) ?? [];
}
