import type { Metadata } from "next";
import type { ReactNode } from "react";
import type { PageMapItem } from "nextra";
import { Footer, Layout, Navbar } from "nextra-theme-docs";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import "nextra-theme-docs/style.css";

const repo = "https://github.com/johann-su/3dp_proj_mgmt";

export const metadata: Metadata = {
  title: {
    default: "Print Vault",
    template: "%s – Print Vault",
  },
  description:
    "Self-hosted management platform for 3D-printing models — operator and user documentation",
};

// The dev/agent architecture notes (docs/architecture/) are already hidden
// from the sidebar via docs/_meta.js and dropped from the export by the
// catch-all route's generateStaticParams; filtering them here as well keeps
// even their titles and file paths out of the page map serialized into every
// page's payload.
function withoutArchitecture(pageMap: PageMapItem[]): PageMapItem[] {
  return pageMap.flatMap((item) => {
    if ("data" in item) {
      const { architecture: _dropped, ...data } = item.data;
      return [{ ...item, data } as PageMapItem];
    }
    if ("name" in item && item.name === "architecture") return [];
    return [item];
  });
}

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout
          navbar={<Navbar logo={<b>Print Vault</b>} projectLink={repo} />}
          pageMap={withoutArchitecture(await getPageMap())}
          docsRepositoryBase={`${repo}/tree/main/docs`}
          editLink="Edit this page on GitHub"
          footer={
            <Footer>
              Print Vault — <a href={repo}>source on GitHub</a>
            </Footer>
          }
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
