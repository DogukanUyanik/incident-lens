import { getConfig, realDeps } from "../../../lib/handlers";

// Thin route: all logic and checks are in lib/handlers.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => getConfig(request, realDeps());
