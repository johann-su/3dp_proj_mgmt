import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// The dead end of the MCP connect flow — the only useful advice is to start over in the client, since every link here is one-shot and expires.
export function McpProblem({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{detail}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
