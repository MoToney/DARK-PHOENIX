"use client";

import {useState} from "react";
import {useForm} from "react-hook-form";
import {zodResolver} from "@hookform/resolvers/zod";
import {z} from "zod";

import {cn} from "~/lib/utils";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "./ui/card";
import {Input} from "./ui/input";
import {Label} from "./ui/label";
import {Button} from "./ui/button";

const youtubeSchema = z.object({
    url: z
        .string()
        .url("Enter a valid URL")
        .refine(
            (url) => url.includes("youtube.com") || url.includes("youtu.be"),
            "Enter a valid YouTube URL",
        ),
});

type YoutubeFormValues = z.infer<typeof youtubeSchema>;

type YoutubeFormProps = {
    onSubmit: (url: string) => Promise<void>;
    isSubmitting: boolean;
    className?: string;
};

export function YoutubeForm({onSubmit, isSubmitting, className}: YoutubeFormProps) {
    const [error, setError] = useState<string | null>(null);

    const {
        register,
        handleSubmit,
        reset,
        formState: {errors},
    } = useForm<YoutubeFormValues>({
        defaultValues: {
        url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    },
        resolver: zodResolver(youtubeSchema),
    });


    const onValid = async (data: YoutubeFormValues) => {
        try {
            setError(null);
            await onSubmit(data.url);   // <- unwrap here
            reset();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to submit YouTube video");
        }
    };

    return (
        <div className={cn("flex flex-col gap-6", className)}>
            <Card>
                <CardHeader>
                    <CardTitle className="text-2xl">YouTube Ingestion</CardTitle>
                    <CardDescription>
                        Enter a YouTube video link to download, upload to S3, and process.
                    </CardDescription>
                </CardHeader>

                <CardContent>
                    <form onSubmit={handleSubmit(onValid)}>
                        <div className="flex flex-col gap-6">
                            <div className="grid gap-2">
                                <Label htmlFor="url">YouTube URL</Label>
                                <Input
                                    id="url"
                                    type="url"
                                    placeholder="https://www.youtube.com/watch?v=YRvf00NooN8"
                                    required
                                    {...register("url")}
                                />

                                {errors.url && (
                                    <p className="text-sm text-red-500">
                                        {errors.url.message}
                                    </p>
                                )}
                            </div>

                            {error && (
                                <p className="rounded-md bg-red-50 p-3 text-sm text-red-500">
                                    {error}
                                </p>
                            )}

                            <Button type="submit" className="w-full" disabled={isSubmitting}>
                                {isSubmitting ? "Submitting..." : "Submit YouTube Video"}
                            </Button>
                        </div>
                    </form>
                </CardContent>
            </Card>
        </div>
    );
}