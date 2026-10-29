import { postScript, realDeps } from "../../../../../lib/handlers";

// Thin route: all logic and checks are in lib/handlers.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return postScript(request, (await params).id, "trigger", realDeps());
}
