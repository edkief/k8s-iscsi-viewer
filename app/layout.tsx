import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "iSCSI Volume Viewer",
  description: "Monitor TrueNAS / democratic-csi iSCSI PersistentVolumeClaims",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
