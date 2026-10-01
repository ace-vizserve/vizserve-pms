-- P15-04 — a client form names its own three request fields.
--
-- Title, description and target date are columns on vizserve_pms_requests,
-- not questions, so they stay on every client form. Only their LABELS are the
-- form's to choose. NULL means the default ("Title", "Description",
-- "Target date"), so every existing form reads exactly as it did.
--
-- No grant: privileges on vizserve_pms_forms are table-level and cover new
-- columns.

alter table vizserve_pms_forms
  add column title_label       text,
  add column description_label text,
  add column target_date_label text;

alter table vizserve_pms_forms
  add constraint vizserve_pms_forms_title_label_shape
    check (title_label is null or (title_label = btrim(title_label) and length(title_label) between 1 and 120)),
  add constraint vizserve_pms_forms_description_label_shape
    check (description_label is null or (description_label = btrim(description_label) and length(description_label) between 1 and 120)),
  add constraint vizserve_pms_forms_target_date_label_shape
    check (target_date_label is null or (target_date_label = btrim(target_date_label) and length(target_date_label) between 1 and 120));

-- Same function as 20260803100000_p1_09_attachments.sql, plus `request_labels`.
create or replace function vizserve_pms_get_public_form(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'id', f.id,
    'name', f.name,
    'slug', f.slug,
    'description', f.description,
    'requires_attachment', f.requires_attachment,
    'request_labels', jsonb_build_object(
      'title', f.title_label,
      'description', f.description_label,
      'target_date', f.target_date_label
    ),
    'attachment_rules', (
      select jsonb_build_object(
        'max_bytes', r.max_bytes,
        'max_files', r.max_files_per_form,
        'allowed_mime_types', to_jsonb(r.allowed_mime_types)
      )
      from vizserve_pms_attachment_rules r where r.id
    ),
    'fields', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', ff.id,
            'label', ff.label,
            'field_key', ff.field_key,
            'field_type', ff.field_type,
            'help_text', ff.help_text,
            'options', ff.options,
            'is_required', ff.is_required
          ) order by ff.sort_order, ff.created_at
        )
        from vizserve_pms_form_fields ff
        where ff.form_id = f.id and ff.is_active
      ),
      '[]'::jsonb
    )
  )
  from vizserve_pms_forms f
  where f.slug = p_slug and f.is_public and f.is_active
$$;

revoke all on function vizserve_pms_get_public_form(text) from public;
grant execute on function vizserve_pms_get_public_form(text) to anon, authenticated;
