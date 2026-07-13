import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "A2A + A2UI Workbench | CognicellAI",
  description:
    "A CognicellAI protocol workbench for testing A2A message streams and rendering A2UI output.",
  icons: {
    icon: "/assets/cognicellai-logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="flex h-full flex-col">{children}</body>
    </html>
  );
}
