import { sql, type AnyColumn, type SQL } from "drizzle-orm";

// A model is "parametric" when it ships a `.scad` source file — the OpenSCAD
// customizer flow keys off that (see AGENTS.md). Browse cards surface it as a
// badge, so the model listing queries compute this flag inline.
//
// Returned as a relational-query `extras` value: pass the model-id column from
// the extras callback (`extras: (m) => ({ parametric: parametricExtra(m.id) })`).
// The subquery uses a fresh `scad_mf` alias so it never collides with the
// `files` relation join that also reads model_files.
export function parametricExtra(modelId: AnyColumn | SQL): SQL.Aliased<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM model_files scad_mf
    WHERE scad_mf.model_id = ${modelId} AND scad_mf.filename ILIKE '%.scad'
  )`.as("parametric");
}
