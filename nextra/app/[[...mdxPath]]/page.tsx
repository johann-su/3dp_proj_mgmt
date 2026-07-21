import { generateStaticParamsFor, importPage } from "nextra/pages";
import { useMDXComponents as getMDXComponents } from "../../mdx-components";

type PageProps = Readonly<{
  params: Promise<{ mdxPath?: string[] }>;
}>;

// content/architecture (docs/architecture/ in the repo) holds the dev/agent
// architecture notes, which are not part of the operator docs site. Dropping
// their routes here keeps them out of the static export and the Pagefind
// search index; docs/_meta.js additionally hides the folder from the sidebar.
export async function generateStaticParams() {
  const params = await generateStaticParamsFor("mdxPath")();
  return params.filter((p) => p.mdxPath?.[0] !== "architecture");
}

export async function generateMetadata(props: PageProps) {
  const params = await props.params;
  const { metadata } = await importPage(params.mdxPath);
  return metadata;
}

const Wrapper = getMDXComponents().wrapper;

export default async function Page(props: PageProps) {
  const params = await props.params;
  const {
    default: MDXContent,
    toc,
    metadata,
    sourceCode,
  } = await importPage(params.mdxPath);
  return (
    <Wrapper toc={toc} metadata={metadata} sourceCode={sourceCode}>
      <MDXContent {...props} params={params} />
    </Wrapper>
  );
}
