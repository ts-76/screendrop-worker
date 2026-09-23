CREATE TABLE `collection_uploads` (
	`collection_id` text NOT NULL,
	`upload_id` text NOT NULL,
	PRIMARY KEY(`collection_id`, `upload_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_collection_uploads_upload_id` ON `collection_uploads` (`upload_id`,`collection_id`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collections_name_key_unique` ON `collections` (`name_key`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_key_unique` ON `tags` (`name_key`);--> statement-breakpoint
CREATE TABLE `upload_tags` (
	`upload_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`upload_id`, `tag_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_upload_tags_tag_id` ON `upload_tags` (`tag_id`,`upload_id`);