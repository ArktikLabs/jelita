CREATE TABLE "branch_hours" (
	"team_id" text NOT NULL,
	"weekday" smallint NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"opens_at" time DEFAULT '09:00' NOT NULL,
	"closes_at" time DEFAULT '21:00' NOT NULL,
	CONSTRAINT "branch_hours_team_id_weekday_pk" PRIMARY KEY("team_id","weekday")
);
--> statement-breakpoint
CREATE TABLE "branch_profiles" (
	"team_id" text PRIMARY KEY NOT NULL,
	"address" text,
	"phone" text,
	"active" boolean DEFAULT true NOT NULL,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "branch_hours" ADD CONSTRAINT "branch_hours_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_profiles" ADD CONSTRAINT "branch_profiles_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;