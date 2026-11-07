import { healthReport } from "@/lib/health";

export async function GET() {
  const report = await healthReport();
  return Response.json(report, {
    status: report.ok ? 200 : 503,
    headers: { "cache-control": "no-store, max-age=0" },
  });
}
