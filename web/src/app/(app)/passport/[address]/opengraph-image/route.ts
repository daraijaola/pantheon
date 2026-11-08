import Image from "../opengraph-image";

export async function GET(_request: Request, { params }: { params: Promise<{ address: string }> }) {
  return Image({ params });
}
