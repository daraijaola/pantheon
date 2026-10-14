import { Footer } from "@/components/footer/footer";
import { SiteHeader } from "@/components/menu/site-header";
import { packCode, readOurCode } from "@/lib/our-code";

/** Every page: the frame rails, the header with its Explore menu, the page, the footer. */
export async function SiteShell({ children }: { children: React.ReactNode }) {
  const fill = packCode(await readOurCode());
  return (
    <div className="relative min-h-svh bg-paper text-ink">
      {/* Frame: the two rails of the 1112px column run the full page. */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-y-0 left-1/2 z-20 w-[min(1112px,calc(100%-32px))] -translate-x-1/2 border-x border-rule"
      />
      <SiteHeader code={fill} />
      {children}
      <Footer code={fill} />
    </div>
  );
}
