import { getReplay, realDeps } from "../../../../lib/handlers";

// Thin route: all logic and checks are in lib/handlers.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => getReplay(request, realDeps());
