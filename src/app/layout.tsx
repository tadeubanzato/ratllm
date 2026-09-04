import type { Metadata } from "next";
import { Sidebar } from "@/components/sidebar";
import "./globals.css";

export const metadata: Metadata = { title: { default: "Okame Model Curator", template: "%s · Okame" }, description: "Self-hosted AI model deployment control plane" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en" suppressHydrationWarning><body><Sidebar/><div className="app-content">{children}</div></body></html>; }
