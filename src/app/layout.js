import "./globals.css";

export const metadata = {
  title: "3D City & Nature Simulator Ultra Pro",
  description: "A Three.js disaster, survival, and construction simulator.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
