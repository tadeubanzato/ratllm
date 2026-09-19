import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "RatLLM Model Curator",
    short_name: "RatLLM",
    description: "Self-hosted AI model deployment control plane",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f6f8",
    theme_color: "#cc0000",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
