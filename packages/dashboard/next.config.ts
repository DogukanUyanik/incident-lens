import type { NextConfig } from "next";

const config: NextConfig = {
  // Nothing from the server's environment is exposed to the browser bundle.
  poweredByHeader: false,
};

export default config;
