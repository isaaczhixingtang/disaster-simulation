import "./globals.css";

export const metadata = {
  title: "3D City & Nature Simulator Ultra Pro",
  description: "A Three.js disaster, survival, and construction simulator.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#020617",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
