import Link from "next/link";
import {auth} from "~/server/auth";
import {redirect} from "next/navigation";

export default async function HomePage() {
  const session = await auth();

  if (session) {
    redirect("/dashboard");
  }
  redirect("/login")
}
