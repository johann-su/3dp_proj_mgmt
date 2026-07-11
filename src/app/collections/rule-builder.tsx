"use client";

import { Plus, X } from "lucide-react";
import {
  MAX_RULE_DEPTH,
  RULE_FIELD_LABELS,
  SOURCE_VALUE_LABELS,
  isRuleGroup,
  type RuleCondition,
  type RuleField,
  type RuleGroup,
  type RuleNode,
} from "@/lib/collection-rules";
import { PRINT_TIME_BUCKETS } from "@/lib/search-params";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Dropdown options for the rule editor, queried server-side (searchFacets plus
// tags/categories) and passed down because the builder is a client component.
export type RuleBuilderFacets = {
  users: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  printers: string[];
  filaments: string[];
  nozzles: number[];
};

const FIELD_ORDER: RuleField[] = [
  "tags",
  "category",
  "uploader",
  "source",
  "printer",
  "filament",
  "nozzle",
  "printTime",
  "parametric",
  "addedWithin",
  "text",
  "downloads",
];

// A freshly-added condition for a field: valid where an obvious default exists,
// otherwise empty — parseRuleTree rejects it at save time with a message.
function defaultCondition(field: RuleField, facets: RuleBuilderFacets): RuleCondition {
  switch (field) {
    case "tags":
      return { field, op: "any", value: [] };
    case "category":
      return { field, value: facets.categories[0]?.id ?? "" };
    case "uploader":
      return { field, value: facets.users[0]?.id ?? "" };
    case "source":
      return { field, value: "makerworld" };
    case "printer":
      return { field, value: facets.printers[0] ?? "" };
    case "filament":
      return { field, value: facets.filaments[0] ?? "" };
    case "nozzle":
      return { field, value: facets.nozzles[0] ?? 0.4 };
    case "printTime":
      return { field, value: PRINT_TIME_BUCKETS[0].maxSeconds };
    case "parametric":
      return { field };
    case "addedWithin":
      return { field, value: 30 };
    case "text":
      return { field, value: "" };
    case "downloads":
      return { field, value: 1 };
  }
}

export function emptyRuleGroup(): RuleGroup {
  return { op: "AND", rules: [] };
}

// Recursive AND/OR rule editor (issue #46). Purely controlled: edits produce a
// new tree via onChange; validation happens server-side on save.
export function RuleBuilder({
  value,
  onChange,
  facets,
}: {
  value: RuleGroup;
  onChange: (group: RuleGroup) => void;
  facets: RuleBuilderFacets;
}) {
  return <GroupEditor group={value} onChange={onChange} facets={facets} depth={1} />;
}

function GroupEditor({
  group,
  onChange,
  onRemove,
  facets,
  depth,
}: {
  group: RuleGroup;
  onChange: (group: RuleGroup) => void;
  onRemove?: () => void;
  facets: RuleBuilderFacets;
  depth: number;
}) {
  function setRule(index: number, rule: RuleNode) {
    onChange({ ...group, rules: group.rules.map((r, i) => (i === index ? rule : r)) });
  }
  function removeRule(index: number) {
    onChange({ ...group, rules: group.rules.filter((_, i) => i !== index) });
  }
  function addRule(rule: RuleNode) {
    onChange({ ...group, rules: [...group.rules, rule] });
  }

  return (
    <div
      className={cn(
        "grid gap-2",
        depth > 1 && "border-l-2 border-border pl-3 py-1",
      )}
    >
      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-md border border-input overflow-hidden">
          {(["AND", "OR"] as const).map((op) => (
            <button
              key={op}
              type="button"
              onClick={() => onChange({ ...group, op })}
              className={cn(
                "px-2.5 py-1 text-xs font-medium transition-colors",
                group.op === op
                  ? "bg-primary text-primary-foreground"
                  : "bg-transparent text-muted-foreground hover:bg-muted",
              )}
            >
              {op === "AND" ? "Match all" : "Match any"}
            </button>
          ))}
        </div>
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={onRemove}
            aria-label="Remove group"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>

      {group.rules.map((rule, i) =>
        isRuleGroup(rule) ? (
          <GroupEditor
            key={i}
            group={rule}
            onChange={(g) => setRule(i, g)}
            onRemove={() => removeRule(i)}
            facets={facets}
            depth={depth + 1}
          />
        ) : (
          <ConditionRow
            key={i}
            condition={rule}
            onChange={(c) => setRule(i, c)}
            onRemove={() => removeRule(i)}
            facets={facets}
          />
        ),
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => addRule(defaultCondition("tags", facets))}
        >
          <Plus className="size-3.5" />
          Condition
        </Button>
        {depth < MAX_RULE_DEPTH && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => addRule({ op: "OR", rules: [defaultCondition("tags", facets)] })}
          >
            <Plus className="size-3.5" />
            Group
          </Button>
        )}
      </div>
    </div>
  );
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
  facets,
}: {
  condition: RuleCondition;
  onChange: (c: RuleCondition) => void;
  onRemove: () => void;
  facets: RuleBuilderFacets;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={condition.field}
        onValueChange={(field) =>
          onChange({ ...defaultCondition(field as RuleField, facets), negate: condition.negate })
        }
      >
        <SelectTrigger size="sm" className="w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FIELD_ORDER.map((f) => (
            <SelectItem key={f} value={f}>
              {RULE_FIELD_LABELS[f]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        type="button"
        variant={condition.negate ? "destructive" : "outline"}
        size="sm"
        className="px-2 text-xs"
        onClick={() => onChange({ ...condition, negate: !condition.negate })}
        title="Invert this condition"
      >
        NOT
      </Button>

      <ValueEditor condition={condition} onChange={onChange} facets={facets} />

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
        onClick={onRemove}
        aria-label="Remove condition"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

// The value input(s) for a condition, per field type. Facet-backed fields use
// a select; free-form ones a plain input. Text inputs are uncontrolled (keyed
// by field) so typing isn't disturbed by the round-trip through the tree.
function ValueEditor({
  condition,
  onChange,
  facets,
}: {
  condition: RuleCondition;
  onChange: (c: RuleCondition) => void;
  facets: RuleBuilderFacets;
}) {
  switch (condition.field) {
    case "tags":
      return (
        <>
          <Select
            value={condition.op}
            onValueChange={(op) => onChange({ ...condition, op: op as "any" | "all" })}
          >
            <SelectTrigger size="sm" className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">any of</SelectItem>
              <SelectItem value="all">all of</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="h-8 w-56"
            placeholder="comma, separated, tags"
            defaultValue={condition.value.join(", ")}
            onChange={(e) =>
              onChange({
                ...condition,
                value: e.target.value.split(",").map((t) => t.trim()).filter(Boolean),
              })
            }
          />
        </>
      );
    case "category":
      return (
        <FacetSelect
          value={condition.value}
          options={facets.categories.map((c) => ({ value: c.id, label: c.name }))}
          onChange={(value) => onChange({ ...condition, value })}
        />
      );
    case "uploader":
      return (
        <FacetSelect
          value={condition.value}
          options={facets.users.map((u) => ({ value: u.id, label: u.name }))}
          onChange={(value) => onChange({ ...condition, value })}
        />
      );
    case "source":
      return (
        <FacetSelect
          value={condition.value}
          options={Object.entries(SOURCE_VALUE_LABELS).map(([value, label]) => ({
            value,
            label,
          }))}
          onChange={(value) =>
            onChange({ ...condition, value: value as typeof condition.value })
          }
        />
      );
    case "printer":
      return (
        <FacetSelect
          value={condition.value}
          options={facets.printers.map((p) => ({ value: p, label: p }))}
          onChange={(value) => onChange({ ...condition, value })}
          fallbackPlaceholder="Printer model"
        />
      );
    case "filament":
      return (
        <FacetSelect
          value={condition.value}
          options={facets.filaments.map((f) => ({ value: f, label: f }))}
          onChange={(value) => onChange({ ...condition, value })}
          fallbackPlaceholder="e.g. PETG"
        />
      );
    case "nozzle":
      return facets.nozzles.length > 0 ? (
        <FacetSelect
          value={String(condition.value)}
          options={facets.nozzles.map((n) => ({ value: String(n), label: `${n} mm` }))}
          onChange={(value) => onChange({ ...condition, value: Number(value) })}
        />
      ) : (
        <NumberInput condition={condition} onChange={onChange} step="0.1" suffix="mm" />
      );
    case "printTime":
      return (
        <FacetSelect
          value={String(condition.value)}
          options={PRINT_TIME_BUCKETS.map((b) => ({
            value: String(b.maxSeconds),
            label: b.label.toLowerCase(),
          }))}
          onChange={(value) => onChange({ ...condition, value: Number(value) })}
        />
      );
    case "parametric":
      return (
        <span className="text-sm text-muted-foreground">has a .scad source</span>
      );
    case "addedWithin":
      return <NumberInput condition={condition} onChange={onChange} suffix="days" />;
    case "text":
      return (
        <Input
          className="h-8 w-56"
          placeholder="words to match"
          defaultValue={condition.value}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
        />
      );
    case "downloads":
      return <NumberInput condition={condition} onChange={onChange} suffix="or more" />;
  }
}

function FacetSelect({
  value,
  options,
  onChange,
  fallbackPlaceholder,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  // Free-text fallback when the corpus has no facet values yet.
  fallbackPlaceholder?: string;
}) {
  if (options.length === 0 && fallbackPlaceholder) {
    return (
      <Input
        className="h-8 w-44"
        placeholder={fallbackPlaceholder}
        defaultValue={value}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger size="sm" className="w-44">
        <SelectValue placeholder="Choose…" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NumberInput({
  condition,
  onChange,
  step,
  suffix,
}: {
  condition: Extract<RuleCondition, { value: number }>;
  onChange: (c: RuleCondition) => void;
  step?: string;
  suffix?: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Input
        type="number"
        min="0"
        step={step}
        className="h-8 w-24"
        defaultValue={condition.value}
        onChange={(e) => onChange({ ...condition, value: Number(e.target.value) })}
      />
      {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
    </span>
  );
}
