import type { Metadata } from "next";
import "./globals.css";
import { TopLoader } from "@/components/top-loader";

// Everything here reads live system state; never prerender at build time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: { default: "Kiwin", template: "%s · Kiwin" },
    description: "Kiwin server administration",
    robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <body>
                <TopLoader />
                {children}
            </body>
        </html>
    );
}
