import {PrismaClient} from "@prisma/client";
import {hashPassword} from "../src/lib/auth";
import {env} from "../src/env";
import Stripe from "stripe";

const db = new PrismaClient();

async function main() {
    const email = "reviewer@example.com";

    const existing = await db.user.findUnique({
        where: {email},
    });

    if (existing) {
        console.log("Reviewer already exists.");
        return;
    }

    const hashedPassword = await hashPassword("Password123!");

    let stripeCustomerId: string | null = null;

    try {
        if (
            env.STRIPE_SECRET_KEY &&
            !env.STRIPE_SECRET_KEY.includes("placeholder")
        ) {
            const stripe = new Stripe(env.STRIPE_SECRET_KEY);

            const customer = await stripe.customers.create({
                email,
            });

            stripeCustomerId = customer.id;
        }
    } catch (err) {
        console.warn("Stripe customer creation failed:", err);
    }

    await db.user.create({
        data: {
            email,
            password: hashedPassword,
            stripeCustomerId,
            approved: true,
        },
    });

    console.log("Reviewer account created.");
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(async () => {
        await db.$disconnect();
    });

