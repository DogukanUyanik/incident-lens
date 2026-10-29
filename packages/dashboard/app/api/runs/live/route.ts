import { postLive, realDeps } from "../../../../lib/handlers";

// Thin route: all logic and checks are in lib/handlers.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => postLive(request, realDeps());
