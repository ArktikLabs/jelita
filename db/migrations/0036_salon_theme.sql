ALTER TABLE "salon_profiles" ADD COLUMN "theme" text DEFAULT 'ivory' NOT NULL;
--> statement-breakpoint
-- The keys are lib/theme.ts THEMES. Adding a preset is a constant plus this
-- constraint; the pair moves together or the form starts writing keys the
-- layout cannot render.
alter table salon_profiles add constraint salon_profiles_theme
  check (theme in ('ivory', 'charcoal', 'rose-gold', 'sage', 'sapphire'));