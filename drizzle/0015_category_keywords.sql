-- Category keywords + "no model without a category".
--
-- Adds categories.keywords, the match terms behind category suggestion
-- (src/lib/category-suggest.ts). The keyword data mirrors
-- src/lib/category-defaults.ts — keep the two in sync. The upsert both seeds
-- fresh databases (this runs before scripts/migrate.mjs's name-only insert)
-- and fills keywords in on existing ones. Finally, every uncategorized model
-- is backfilled to "Other" — the UI and the import paths now always assign a
-- category, so no model should be blank.
ALTER TABLE "categories" ADD COLUMN "keywords" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
INSERT INTO "categories" (name, slug, keywords) VALUES
  ('Art', 'art', ARRAY['art', '2d art', 'coin', 'badge', 'coin & badges', 'sign', 'logo', 'signs & logos', 'sculpture', 'statue', 'bust', 'relief', 'lithophane', 'wall art', 'painting', 'drawing']),
  ('Fashion', 'fashion', ARRAY['fashion', 'bag', 'clothes', 'clothing', 'earring', 'footwear', 'shoe', 'glasses', 'sunglasses', 'jewelry', 'jewellery', 'jewlery', 'ring', 'bracelet', 'necklace', 'pendant', 'keychain', 'wearable', 'cosplay', 'props & cosplay', 'costume', 'mask', 'helmet', 'masks & helmets']),
  ('Functional', 'functional', ARRAY['functional', '3d printer', '3d printer accessories', '3d printer parts', 'test models', 'calibration', 'benchy', 'spool', 'filament', 'ams', 'mount', 'bracket', 'holder', 'hook', 'clip', 'clamp', 'stand', 'hinge', 'adapter', 'spacer', 'repair', 'replacement', 'spare part']),
  ('Gadgets', 'gadgets', ARRAY['gadget', 'hobby & diy', 'electronics', 'electronic', 'rc', 'robotics', 'robot', 'drone', 'fpv', 'arduino', 'raspberry pi', 'esp32', 'music', 'headphone', 'speaker', 'camera', 'phone', 'smartphone', 'tablet', 'laptop', 'keyboard', 'controller', 'vehicle', 'sport & outdoors']),
  ('Games & Toys', 'games-toys', ARRAY['toy', 'toys & games', 'game', 'board game', 'puzzle', 'jigsaw', 'dice', 'chess', 'fidget', 'spinner', 'character', 'outdoor toys', 'construction sets', 'brick', 'card game']),
  ('Household', 'household', ARRAY['household', 'home', 'decor', 'decoration', 'decorative', 'festivities', 'holiday', 'christmas', 'halloween', 'easter', 'garden', 'planter', 'plant', 'vase', 'pot', 'office', 'desk', 'pet', 'dog', 'cat', 'kitchen', 'bathroom', 'furniture', 'lamp', 'lighting', 'shelf', 'coaster']),
  ('Miniatures', 'miniatures', ARRAY['miniature', 'mini', 'animal', 'architecture', 'building', 'creature', 'dragon', 'people', 'figure', 'figurine', 'terrain', 'tabletop', 'dnd', 'd&d', 'warhammer', 'scale model', 'diorama']),
  ('Tools', 'tools', ARRAY['tool', 'hand tools', 'machine tools', 'measure tools', 'measuring', 'medical tools', 'organizer', 'gridfinity', 'jig', 'wrench', 'screwdriver', 'drill', 'saw', 'ruler', 'caliper', 'workshop', 'workbench', 'garage', 'storage', 'box', 'container', 'tray', 'sorter']),
  ('Other', 'other', '{}'::text[])
ON CONFLICT (slug) DO UPDATE SET keywords = EXCLUDED.keywords;
--> statement-breakpoint
UPDATE "models" SET category_id = (SELECT id FROM "categories" WHERE slug = 'other')
WHERE category_id IS NULL;
