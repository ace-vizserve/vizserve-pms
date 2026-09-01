/**
 * Database types.
 *
 * HAND-WRITTEN, and only until a database is reachable. Regenerate with
 * `npm run db:types` (needs `npm run db:start`, which needs Docker running) and
 * treat the generated file as authoritative from that point on — if this drifts
 * from the migrations, the migrations are right.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type VizservePmsUserRole = "member" | "team_leader" | "manager" | "admin";

export type VizservePmsNotificationType =
  | "pending_approval"
  | "assigned"
  | "status_changed"
  | "qa_requested"
  | "client_decision"
  | "commented"
  | "internal_decision";

export type VizservePmsFieldType =
  | "text"
  | "textarea"
  | "date"
  | "select"
  | "multiselect"
  | "file"
  | "email"
  | "number";

export type VizservePmsApprovalDecision = "approved" | "returned" | "rejected";

/**
 * Phase 5's four, plus OVERTIME from P7-03. Leave balances stay out of scope.
 *
 * Adding a value here is only half the job — `vizserve_pms_internal_requests`
 * carries a per-type CHECK whose `else` branch used to swallow anything new.
 */
/**
 * P7-16. Which half of a day leave starts or ends in.
 *
 * MORNING is declared first in the Postgres enum, so `start_half <= end_half` is
 * a direct comparison there. Keep this union in the same order for the same
 * reason the priority one is kept in its order.
 */
export type VizservePmsDayHalf = "MORNING" | "AFTERNOON";

/**
 * P7-42. How one leave type appears on the shared calendar to somebody who is
 * NOT the requester.
 *
 *   FULL          name, real label, dates and halves
 *   LABEL_HIDDEN  name and dates; the label reads "On leave"
 *   HIDDEN        the row is not returned at all — the absence is withheld
 *
 * Declared low → high, like the role enum, so a `>=` comparison in SQL would
 * mean what it looks like. The requester is exempt from every level on their
 * own rows.
 */
export type VizservePmsLeaveCalendarVisibility = "FULL" | "LABEL_HIDDEN" | "HIDDEN";

/**
 * P7-32. An enum rather than text so the first report that groups by it is not
 * counting "M", "male" and "Male " as three answers. NULL on the column means
 * "not recorded yet" — the auth trigger creates profile rows with no gender to
 * supply — never "declined to say".
 */
export type VizservePmsGender = "MALE" | "FEMALE";

/**
 * P7-46. An ENUM rather than a table, which is the other side of the P7-12
 * argument: leave types are policy data HR edits, these three are structural.
 * `DEPARTMENT` is the only one carrying a department_id, the shape constraint
 * branches on that, and the calendar paints one colour per member.
 */
export type VizservePmsEventCategory = "COMPANY" | "MANAGEMENT" | "DEPARTMENT";

/**
 * P7-38 added the last two. NO_TIME_* means there is no punch to read;
 * *_CORRECTION means there is one and it is wrong. Same payload, same DTR
 * write-back, different claim — see the migration's header for why they are not
 * one type.
 */
export type VizservePmsInternalRequestType =
  | "LEAVE"
  | "NO_TIME_IN"
  | "NO_TIME_OUT"
  | "TIME_IN_CORRECTION"
  | "TIME_OUT_CORRECTION"
  | "REIMBURSEMENT"
  | "OVERTIME";

/** No RETURNED: P5-08 specifies approve or reject only. */
export type VizservePmsInternalRequestStatus = "PENDING_REVIEW" | "APPROVED" | "REJECTED";

/**
 * P7-05. No DRAFT — a week with no row has not been submitted, and a state that
 * never appears in the table is one somebody eventually writes by mistake.
 */
export type VizservePmsTimesheetWeekStatus = "SUBMITTED" | "RETURNED" | "APPROVED";

/**
 * A client's answer at Gate 3.
 *
 * AUTO_COMPLETED is deliberately in the same enum and deliberately never called
 * "approved". "The client approved" and "nobody answered and the clock ran out"
 * are different facts, and if a dispute happens the record has to show which.
 */
export type VizservePmsClientDecision = "APPROVED" | "REVISION_REQUESTED" | "AUTO_COMPLETED";

export type VizservePmsTokenPurpose = "approval" | "feedback";

/**
 * The canonical task status set (docs/01 §3), in the corrected order.
 *
 * COMPLETED is terminal and comes AFTER the client signs off — the Miro board
 * had Testing/QA → Completed → Submit for Final Approval, and Amier corrected
 * himself live. COMPLETED_NO_RESPONSE is deliberately distinct: "the client
 * approved" and "the clock ran out" are different facts.
 */
export type VizservePmsTaskStatus =
  | "OPEN"
  | "ONGOING"
  | "WAITING_FOR_INFO"
  | "FOR_QA"
  | "QA_IN_PROGRESS"
  | "FOR_CLIENT_APPROVAL"
  | "COMPLETED"
  | "COMPLETED_NO_RESPONSE";

/**
 * P7-11. Declared low → high in SQL, so Postgres compares and sorts them in
 * that order; this union is unordered, and `TASK_PRIORITIES` in
 * `lib/schemas/tasks.ts` is the copy that carries the ranking.
 *
 * The column is NULLABLE and null is a real value — "no priority", the
 * picker's "Clear". It is not an absence to be defaulted away.
 */
export type VizservePmsTaskPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

export type VizservePmsRequestStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "PENDING_REVIEW"
  | "APPROVED"
  | "RETURNED"
  | "REJECTED";

export type Database = {
  public: {
    Tables: {
      vizserve_pms_departments: {
        Row: {
          id: string;
          name: string;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      vizserve_pms_users: {
        Row: {
          id: string;
          email: string;
          full_name: string;
          role: VizservePmsUserRole;
          primary_department_id: string | null;
          is_active: boolean;
          /**
           * Which HFSE applications this person may enter.
           *
           * The source of truth for the access gate. Mirrored into
           * `raw_app_meta_data` — service-role writable only, therefore
           * trustworthy — and NEVER read from `raw_user_meta_data`, which the
           * user can rewrite through GoTrue with their own token (D18).
           */
          app_access: string[];
          /**
           * P7-32. Required by the admin form, nullable here — see the column
           * comment in 20260824090000_p7_32_gender.sql. NULL is an account
           * nobody has opened since the column landed, not a refusal.
           */
          gender: VizservePmsGender | null;
          /**
           * P7-52. The HR job, ORTHOGONAL to `role` rather than a rank on it.
           * Never test this directly in app code — `canDoHr()` in
           * `lib/auth/authorization.ts` is the single reading, and it returns
           * true for admins, who hold the capability without carrying the flag.
           */
          is_hr: boolean;
          /**
           * P7-36. `HH:MM:SS` Manila wall-clock, both or neither. NULL means no
           * schedule is recorded, so nothing computes lateness for this person —
           * a supported state, not missing data. Normalise through
           * `scheduleFor()` in `lib/dtr-schedule.ts` rather than reading the raw
           * value: Postgres returns seconds that no comparison here wants.
           */
          work_start: string | null;
          work_end: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          full_name?: string;
          role?: VizservePmsUserRole;
          primary_department_id?: string | null;
          is_active?: boolean;
          app_access?: string[];
          gender?: VizservePmsGender | null;
          is_hr?: boolean;
          work_start?: string | null;
          work_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          full_name?: string;
          role?: VizservePmsUserRole;
          primary_department_id?: string | null;
          is_active?: boolean;
          app_access?: string[];
          gender?: VizservePmsGender | null;
          is_hr?: boolean;
          work_start?: string | null;
          work_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_users_primary_department_id_fkey";
            columns: ["primary_department_id"];
            referencedRelation: "vizserve_pms_departments";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_user_managed_departments: {
        Row: {
          user_id: string;
          department_id: string;
          created_at: string;
        };
        Insert: {
          user_id: string;
          department_id: string;
          created_at?: string;
        };
        Update: {
          user_id?: string;
          department_id?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_user_managed_departments_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "vizserve_pms_users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vizserve_pms_user_managed_departments_department_id_fkey";
            columns: ["department_id"];
            referencedRelation: "vizserve_pms_departments";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_audit_logs: {
        Row: {
          id: string;
          entity_type: string;
          entity_id: string;
          action: string;
          actor_id: string | null;
          before: Json | null;
          after: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          entity_type: string;
          entity_id: string;
          action: string;
          actor_id?: string | null;
          before?: Json | null;
          after?: Json | null;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      vizserve_pms_notifications: {
        Row: {
          id: string;
          user_id: string;
          type: VizservePmsNotificationType;
          send_email: boolean;
          entity_type: string | null;
          entity_id: string | null;
          title: string;
          body: string;
          link_path: string | null;
          read_at: string | null;
          emailed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          type: VizservePmsNotificationType;
          send_email?: boolean;
          entity_type?: string | null;
          entity_id?: string | null;
          title: string;
          body?: string;
          link_path?: string | null;
          read_at?: string | null;
          emailed_at?: string | null;
          created_at?: string;
        };
        Update: {
          read_at?: string | null;
          emailed_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_notifications_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "vizserve_pms_users";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_notification_type_settings: {
        Row: {
          type: VizservePmsNotificationType;
          send_email: boolean;
          description: string;
          updated_at: string;
        };
        Insert: {
          type: VizservePmsNotificationType;
          send_email?: boolean;
          description?: string;
          updated_at?: string;
        };
        Update: {
          send_email?: boolean;
          description?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      /**
       * P7-37. ONE ROW, ALWAYS — `id` is a boolean primary key with
       * `check (id)`, so a second insert collides rather than creating a second
       * truth. Read it with `.single()`; there is no case where a caller wants a
       * list of settings rows.
       *
       * No Delete shape is expressible here, and that matches the database: the
       * table has separate INSERT and UPDATE policies and no DELETE policy at
       * all, because a missing row means "the grace period is unknown".
       */
      vizserve_pms_app_settings: {
        Row: {
          id: boolean;
          grace_minutes: number;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: boolean;
          grace_minutes?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          grace_minutes?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_app_settings_updated_by_fkey";
            columns: ["updated_by"];
            referencedRelation: "vizserve_pms_users";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_forms: {
        Row: {
          id: string;
          name: string;
          slug: string;
          description: string;
          department_id: string | null;
          reference_prefix: string;
          is_public: boolean;
          is_active: boolean;
          requires_attachment: boolean;
          sla_minutes: number;
          /** Business days the client gets at Gate 3 before auto-completion. */
          client_approval_days: number;
          default_list_id: string | null;
          /**
           * P7-66 — the `{ entities, root }` builder document,
           * 20260901150000_p7_66_form_schema.sql. Kept in step with
           * `vizserve_pms_form_fields`; the rows stay authoritative until
           * Phase 2.
           */
          schema: Json;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          description?: string;
          department_id?: string | null;
          reference_prefix: string;
          is_public?: boolean;
          is_active?: boolean;
          requires_attachment?: boolean;
          sla_minutes?: number;
          client_approval_days?: number;
          default_list_id?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<{
          name: string;
          slug: string;
          description: string;
          department_id: string | null;
          reference_prefix: string;
          is_public: boolean;
          is_active: boolean;
          requires_attachment: boolean;
          sla_minutes: number;
          client_approval_days: number;
          default_list_id: string | null;
          /** P7-66 — written by the Phase 1 dual-write, and by nothing else. */
          schema: Json;
        }>;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_forms_department_id_fkey";
            columns: ["department_id"];
            referencedRelation: "vizserve_pms_departments";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_form_fields: {
        Row: {
          id: string;
          form_id: string;
          label: string;
          field_key: string;
          field_type: VizservePmsFieldType;
          help_text: string;
          options: Json;
          is_required: boolean;
          is_active: boolean;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          form_id: string;
          label: string;
          field_key: string;
          field_type?: VizservePmsFieldType;
          help_text?: string;
          options?: Json;
          is_required?: boolean;
          is_active?: boolean;
          sort_order?: number;
        };
        Update: Partial<{
          label: string;
          field_key: string;
          field_type: VizservePmsFieldType;
          help_text: string;
          options: Json;
          is_required: boolean;
          is_active: boolean;
          sort_order: number;
        }>;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_form_fields_form_id_fkey";
            columns: ["form_id"];
            referencedRelation: "vizserve_pms_forms";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_requests: {
        Row: {
          id: string;
          form_id: string;
          reference_no: string;
          requester_name: string;
          requester_email: string;
          requester_org: string;
          title: string;
          description: string;
          target_date: string | null;
          approved_target_date: string | null;
          field_values: Json;
          status: VizservePmsRequestStatus;
          decision_reason: string | null;
          reviewed_by: string | null;
          reviewed_at: string | null;
          sla_started_at: string | null;
          submitted_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: Partial<{
          approved_target_date: string | null;
          status: VizservePmsRequestStatus;
          /** P7-51. Set once, at submission. See the migration. */
          status_token_hash: string | null;
          decision_reason: string | null;
          reviewed_by: string | null;
          reviewed_at: string | null;
          title: string;
          description: string;
        }>;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_requests_form_id_fkey";
            columns: ["form_id"];
            referencedRelation: "vizserve_pms_forms";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_request_attachments: {
        Row: {
          id: string;
          request_id: string;
          field_key: string | null;
          storage_path: string;
          filename: string;
          mime_type: string;
          size_bytes: number;
          uploaded_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          request_id: string;
          field_key?: string | null;
          storage_path: string;
          filename: string;
          mime_type: string;
          size_bytes: number;
          uploaded_by?: string | null;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_request_attachments_request_id_fkey";
            columns: ["request_id"];
            referencedRelation: "vizserve_pms_requests";
            referencedColumns: ["id"];
          },
        ];
      };
      // -----------------------------------------------------------------
      // P1-10 / P1-15 — operational tables.
      //
      // Not application data: the counter behind reference numbers, and the
      // Postgres-backed rate limiter. Admin-only under RLS, and typed here
      // because the P0-12 suite asserts against all three.
      // -----------------------------------------------------------------
      vizserve_pms_reference_counters: {
        Row: {
          form_id: string;
          year: number;
          last_value: number;
        };
        Insert: {
          form_id: string;
          year: number;
          last_value?: number;
        };
        Update: Partial<{ last_value: number }>;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_reference_counters_form_id_fkey";
            columns: ["form_id"];
            referencedRelation: "vizserve_pms_forms";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_public_submission_log: {
        Row: {
          id: string;
          form_id: string | null;
          ip: string | null;
          email: string | null;
          accepted: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          form_id?: string | null;
          ip?: string | null;
          email?: string | null;
          accepted?: boolean;
          created_at?: string;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_public_submission_log_form_id_fkey";
            columns: ["form_id"];
            referencedRelation: "vizserve_pms_forms";
            referencedColumns: ["id"];
          },
        ];
      };
      // -----------------------------------------------------------------
      // P2-00 — the generic approval engine.
      //
      // entity_type is a plain discriminator with no FK on purpose: Phase 5
      // adds 'leave_request' and 'dtr_correction' without touching this table.
      // -----------------------------------------------------------------
      vizserve_pms_approvals: {
        Row: {
          id: string;
          entity_type: string;
          entity_id: string;
          department_id: string | null;
          approver_id: string;
          decision: VizservePmsApprovalDecision;
          reason: string | null;
          created_at: string;
        };
        // No insert or update from the app: rows arrive only through
        // vizserve_pms_record_decision, so a decision cannot be forged.
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_approvals_approver_id_fkey";
            columns: ["approver_id"];
            referencedRelation: "vizserve_pms_users";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_tasks: {
        Row: {
          id: string;
          request_id: string | null;
          department_id: string;
          list_id: string | null;
          /**
           * P7-01. True only for a task somebody created for themselves.
           *
           * NOTE its absence from `Update` below: like `status`, it is left out
           * of the column-level UPDATE grant, so it cannot be flipped after the
           * fact. A member reclassifying assigned work as personal would let
           * them close it without review, which is the one thing the three-way
           * category model must not allow.
           */
          is_personal: boolean;
          title: string;
          description: string;
          status: VizservePmsTaskStatus;
          assignee_id: string | null;
          qa_assignee_id: string | null;
          due_date: string | null;
          /** P7-06. Optional, and only ordered against due_date when both exist. */
          start_date: string | null;
          /**
           * P7-09. A subtask names its parent. One level only — a trigger
           * refuses a parent that itself has one, which is also what makes
           * longer cycles impossible.
           */
          parent_task_id: string | null;
          /**
           * P7-11. Null is "nobody ranked this", which is most tasks and is not
           * the same as NORMAL. Unlike `status` and `is_personal` this one IS
           * in the column UPDATE grant below — re-prioritising is ordinary
           * work, not a state transition.
           */
          priority: VizservePmsTaskPriority | null;
          /** P7-15. Minutes somebody expects it to take. Null = nobody estimated. */
          estimate_minutes: number | null;
          field_values: Json;
          resolution: string | null;
          output_link: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        // Tasks are born from an approval (P2-07) or from
        // vizserve_pms_create_task (P3-12). Never from a plain insert.
        Insert: never;
        /**
         * NOTE the absence of `status`. The column-level UPDATE grant is revoked
         * from `authenticated` (P3 migration), so status changes only through
         * `vizserve_pms_transition_task` — which is what makes "every transition
         * is legal and every transition writes history" true rather than hoped
         * for. RLS cannot express a per-column rule; column privileges can.
         */
        Update: Partial<{
          title: string;
          description: string;
          assignee_id: string | null;
          qa_assignee_id: string | null;
          due_date: string | null;
          start_date: string | null;
          parent_task_id: string | null;
          resolution: string | null;
          output_link: string | null;
          list_id: string | null;
          priority: VizservePmsTaskPriority | null;
          estimate_minutes: number | null;
        }>;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_tasks_request_id_fkey";
            columns: ["request_id"];
            referencedRelation: "vizserve_pms_requests";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vizserve_pms_tasks_department_id_fkey";
            columns: ["department_id"];
            referencedRelation: "vizserve_pms_departments";
            referencedColumns: ["id"];
          },
        ];
      };
      // -----------------------------------------------------------------
      // P3 — lists, status history, and the transition table.
      // -----------------------------------------------------------------
      vizserve_pms_lists: {
        Row: {
          id: string;
          department_id: string;
          name: string;
          description: string;
          is_active: boolean;
          sort_order: number;
          /** P7-18. Null is a ClickUp "Folderless List" — the state of every list made before P7-18. */
          group_id: string | null;
          /** P7-18. Set only on a form's auto-created inbox list. */
          form_id: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          department_id: string;
          name: string;
          description?: string;
          is_active?: boolean;
          sort_order?: number;
          group_id?: string | null;
          form_id?: string | null;
          created_by?: string | null;
        };
        /**
         * A CURATED ALLOW-LIST, not a Partial of Row — so a column missing here
         * is a column no server action can write, and `saveList` will not compile
         * against it. `group_id` is present because moving a list between folders
         * is the point of P7-18.
         *
         * `form_id` is deliberately ABSENT. `vizserve_pms_lists_group_guard`
         * refuses to let a form's inbox list leave the Client Requests folder, so
         * offering the column here would only produce a runtime error.
         */
        Update: Partial<{
          name: string;
          description: string;
          is_active: boolean;
          sort_order: number;
          group_id: string | null;
        }>;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_lists_department_id_fkey";
            columns: ["department_id"];
            referencedRelation: "vizserve_pms_departments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vizserve_pms_lists_group_id_fkey";
            columns: ["group_id"];
            referencedRelation: "vizserve_pms_task_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vizserve_pms_lists_form_id_fkey";
            columns: ["form_id"];
            referencedRelation: "vizserve_pms_forms";
            referencedColumns: ["id"];
          },
        ];
      };
      /**
       * P7-18 — folders. One level above lists: Department -> Folder -> List -> Task.
       *
       * Folders DO NOT NEST — there is no `parent_group_id`, matching ClickUp,
       * where depth past one folder level comes from subtasks instead.
       */
      vizserve_pms_task_groups: {
        Row: {
          id: string;
          department_id: string;
          name: string;
          description: string;
          is_active: boolean;
          sort_order: number;
          /** The reserved per-department "Client Requests" folder. Guarded by trigger. */
          is_system: boolean;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          department_id: string;
          name: string;
          description?: string;
          is_active?: boolean;
          sort_order?: number;
          is_system?: boolean;
          created_by?: string | null;
        };
        /**
         * Mirrors `vizserve_pms_task_groups_system_guard`: `department_id` and
         * `is_system` are omitted because the trigger refuses both, so a type that
         * offered them would only be a way to write a runtime error.
         */
        Update: Partial<{
          name: string;
          description: string;
          is_active: boolean;
          sort_order: number;
        }>;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_task_groups_department_id_fkey";
            columns: ["department_id"];
            referencedRelation: "vizserve_pms_departments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vizserve_pms_task_groups_created_by_fkey";
            columns: ["created_by"];
            referencedRelation: "vizserve_pms_users";
            referencedColumns: ["id"];
          },
        ];
      };
      /**
       * Not the audit log. That answers "who changed what"; this answers "how
       * long was it in each state", which is the only way WAITING_FOR_INFO
       * duration is derivable (P3-11, risk R4).
       */
      vizserve_pms_task_status_history: {
        Row: {
          id: string;
          task_id: string;
          from_status: VizservePmsTaskStatus | null;
          to_status: VizservePmsTaskStatus;
          actor_id: string | null;
          comment: string | null;
          is_override: boolean;
          created_at: string;
        };
        // Written only by the transition functions, so a step cannot be hidden.
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_task_status_history_task_id_fkey";
            columns: ["task_id"];
            referencedRelation: "vizserve_pms_tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      /**
       * P3-13 — the PIC's output files.
       *
       * No pending/receipt row, unlike request attachments: a staff upload is
       * authenticated and the upload IS the commit, so there is no gap for a
       * forged path to live in. The server still measures the real bytes.
       */
      vizserve_pms_task_attachments: {
        Row: {
          id: string;
          task_id: string;
          storage_path: string;
          filename: string;
          mime_type: string;
          size_bytes: number;
          kind: "output" | "reference";
          uploaded_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          task_id: string;
          storage_path: string;
          filename: string;
          mime_type: string;
          size_bytes: number;
          kind?: "output" | "reference";
          uploaded_by?: string | null;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_task_attachments_task_id_fkey";
            columns: ["task_id"];
            referencedRelation: "vizserve_pms_tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      // -----------------------------------------------------------------
      // P4 — Gate 3.
      // -----------------------------------------------------------------
      /**
       * Only the HASH is stored. The raw token exists exactly once, in the
       * email that was sent — a dump of this table yields nothing replayable.
       * `token_hash` is deliberately absent from Row: nothing in the app has
       * any reason to read it.
       */
      vizserve_pms_approval_tokens: {
        Row: {
          id: string;
          task_id: string;
          purpose: "approval" | "feedback";
          requester_email: string;
          expires_at: string;
          auto_complete_at: string | null;
          consumed_at: string | null;
          reminded_at: string | null;
          reminder_count: number;
          created_at: string;
        };
        // Issued and consumed by functions only.
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_approval_tokens_task_id_fkey";
            columns: ["task_id"];
            referencedRelation: "vizserve_pms_tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_client_decisions: {
        Row: {
          id: string;
          task_id: string;
          token_id: string | null;
          decision: VizservePmsClientDecision;
          comment: string | null;
          approver_name: string | null;
          ip: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_client_decisions_task_id_fkey";
            columns: ["task_id"];
            referencedRelation: "vizserve_pms_tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_feedback: {
        Row: {
          id: string;
          task_id: string;
          request_id: string | null;
          token_id: string | null;
          rating: number;
          comment: string | null;
          created_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_feedback_task_id_fkey";
            columns: ["task_id"];
            referencedRelation: "vizserve_pms_tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      /** Mirrored in lib/dates.ts PH_HOLIDAYS; a test asserts they agree. */
      /**
       * P7-46. Things HAPPENING, not days off.
       *
       * ⚠️ Deliberately NOT `vizserve_pms_holidays`. That table decides working
       * days — `vizserve_pms_leave_days` and `vizserve_pms_add_business_days`
       * both read it — so a row there changes leave balances and client
       * deadlines. Nothing here feeds any of that, and nothing ever should.
       */
      vizserve_pms_events: {
        Row: {
          id: string;
          title: string;
          description: string | null;
          category: VizservePmsEventCategory;
          /** Set on DEPARTMENT, null on COMPANY and MANAGEMENT. */
          department_id: string | null;
          start_date: string;
          /** Inclusive. A single-day event has end_date === start_date. */
          end_date: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          title: string;
          description?: string | null;
          category: VizservePmsEventCategory;
          department_id?: string | null;
          start_date: string;
          end_date: string;
          created_by?: string | null;
        };
        Update: Partial<{
          title: string;
          description: string | null;
          category: VizservePmsEventCategory;
          department_id: string | null;
          start_date: string;
          end_date: string;
        }>;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_events_department_id_fkey";
            columns: ["department_id"];
            referencedRelation: "vizserve_pms_departments";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_holidays: {
        Row: { holiday_date: string; name: string; created_at: string };
        Insert: { holiday_date: string; name: string };
        Update: Partial<{ name: string }>;
        Relationships: [];
      };
      /**
       * P7-12 — the leave type list.
       *
       * A TABLE rather than an enum, alone among the closed sets in this schema,
       * because it is policy data: HR changes it, and Postgres forbids using a
       * new enum value in the transaction that adds it. Admin-writable, so
       * unlike most tables here `Insert` and `Update` are real.
       *
       * `code` is the stable identifier; `label` is what people read and may be
       * renamed freely. Nothing joins on the label.
       */
      vizserve_pms_leave_types: {
        Row: {
          id: string;
          code: string;
          label: string;
          /** Retired, never deleted — historical requests keep pointing at it. */
          is_active: boolean;
          sort_order: number;
          /**
           * P7-42. What a colleague may see of this type on the shared calendar.
           * HIDDEN on SPECIAL_WOMEN and VAWC (RA 9710; RA 9262 §44),
           * LABEL_HIDDEN on MATERNITY, FULL on everything else — SICK included.
           */
          calendar_visibility: VizservePmsLeaveCalendarVisibility;
          /**
           * P7-45. NULL means the type applies to everyone, which is the
           * default and the common case. A value restricts it — Maternity,
           * Special Leave for Women and VAWC to FEMALE, Paternity to MALE —
           * and is enforced by a trigger as well as filtered in the UI.
           */
          applies_to_gender: VizservePmsGender | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          code: string;
          label: string;
          is_active?: boolean;
          sort_order?: number;
          calendar_visibility?: VizservePmsLeaveCalendarVisibility;
          applies_to_gender?: VizservePmsGender | null;
        };
        Update: Partial<{
          code: string;
          label: string;
          is_active: boolean;
          sort_order: number;
          calendar_visibility: VizservePmsLeaveCalendarVisibility;
          applies_to_gender: VizservePmsGender | null;
        }>;
        Relationships: [];
      };
      /**
       * P7-33. What HR ALLOCATED, per person per leave type per year. Reverses
       * the Phase 5 exclusion; see D27.
       *
       * There is no `days_used` and there never should be. Usage is computed
       * from approved requests by `vizserve_pms_leave_balance_summary`, so a
       * rejected, cancelled or edited request needs no re-credit path and the
       * figure cannot drift out of step with the requests it describes.
       *
       * Admin-writable only — a lead who could set the allowance and then
       * approve leave against it would be on both sides of the question.
       */
      vizserve_pms_leave_balances: {
        Row: {
          id: string;
          user_id: string;
          leave_type_id: string;
          balance_year: number;
          /** Half-day granularity, matching what a request can consume. */
          days_allocated: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          leave_type_id: string;
          balance_year: number;
          days_allocated?: number;
        };
        Update: Partial<{
          days_allocated: number;
        }>;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_leave_balances_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "vizserve_pms_users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vizserve_pms_leave_balances_leave_type_id_fkey";
            columns: ["leave_type_id"];
            referencedRelation: "vizserve_pms_leave_types";
            referencedColumns: ["id"];
          },
        ];
      };
      /** The legal-transition table as data. Mirrored in lib/schemas/tasks.ts. */
      /**
       * P7-13. Additional people on a task. Written only through
       * `vizserve_pms_add_task_assignee` / `..._remove_task_assignee`, so there
       * is no INSERT or DELETE policy and nothing may write here directly.
       */
      vizserve_pms_task_assignees: {
        Row: {
          task_id: string;
          user_id: string;
          added_by: string | null;
          added_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      vizserve_pms_task_comments: {
        Row: {
          id: string;
          task_id: string;
          author_id: string;
          body: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          task_id: string;
          /** Must equal auth.uid() — the INSERT policy says so. */
          author_id: string;
          body: string;
        };
        // Only the body. Reassigning a comment to another author or another
        // task is not editing, it is forgery.
        Update: Partial<{ body: string }>;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_task_comments_task_id_fkey";
            columns: ["task_id"];
            referencedRelation: "vizserve_pms_tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vizserve_pms_task_comments_author_id_fkey";
            columns: ["author_id"];
            referencedRelation: "vizserve_pms_users";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_task_transitions: {
        Row: {
          from_status: VizservePmsTaskStatus;
          to_status: VizservePmsTaskStatus;
          actor: string;
          required_field: string | null;
          /**
           * P7-02. 'any' | 'personal' | 'internal' | 'request' — which kinds of
           * task the rule applies to. Mirrored by `appliesTo` in
           * lib/schemas/tasks.ts, and compared row for row by tests/db.
           */
          applies_to: string;
        };
        // Changing the state machine is a migration, not a row edit.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      // -----------------------------------------------------------------
      // P1-09 — attachments.
      // -----------------------------------------------------------------
      /** Singleton. Upload ceilings, editable without a deploy. */
      vizserve_pms_attachment_rules: {
        Row: {
          id: boolean;
          max_bytes: number;
          max_files_per_form: number;
          allowed_mime_types: string[];
        };
        Insert: {
          id?: boolean;
          max_bytes?: number;
          max_files_per_form?: number;
          allowed_mime_types?: string[];
        };
        Update: Partial<{
          max_bytes: number;
          max_files_per_form: number;
          allowed_mime_types: string[];
        }>;
        Relationships: [];
      };
      /**
       * The upload receipt. A row here means the server measured these exact
       * bytes — it is the only thing `vizserve_pms_submit_request` believes
       * about a file. Service-role only; no policy, so no rows for anyone else.
       */
      vizserve_pms_pending_attachments: {
        Row: {
          id: string;
          form_id: string;
          field_key: string | null;
          storage_path: string;
          filename: string;
          mime_type: string;
          size_bytes: number;
          uploaded_by: string | null;
          ip: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          form_id: string;
          field_key?: string | null;
          storage_path: string;
          filename: string;
          mime_type: string;
          size_bytes: number;
          uploaded_by?: string | null;
          ip?: string | null;
          created_at?: string;
        };
        Update: never;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_pending_attachments_form_id_fkey";
            columns: ["form_id"];
            referencedRelation: "vizserve_pms_forms";
            referencedColumns: ["id"];
          },
        ];
      };
      /** Singleton — tunable at runtime so a flood can be throttled without a deploy. */
      vizserve_pms_public_submission_limits: {
        Row: {
          id: boolean;
          per_ip_per_hour: number;
          per_email_per_hour: number;
        };
        Insert: {
          id?: boolean;
          per_ip_per_hour?: number;
          per_email_per_hour?: number;
        };
        Update: Partial<{
          per_ip_per_hour: number;
          per_email_per_hour: number;
        }>;
        Relationships: [];
      };
      vizserve_pms_dtr_entries: {
        Row: {
          id: string;
          user_id: string;
          work_date: string;
          time_in: string | null;
          time_out: string | null;
          corrected_by: string | null;
          corrected_at: string | null;
          correction_request_id: string | null;
          created_at: string;
          updated_at: string;
        };
        // Rows arrive only through vizserve_pms_punch and the P5-09 correction
        // path — there is no INSERT or UPDATE policy. These exist for the
        // service-role seed path and for tests, not for app code.
        Insert: {
          id?: string;
          user_id: string;
          work_date: string;
          time_in?: string | null;
          time_out?: string | null;
          corrected_by?: string | null;
          corrected_at?: string | null;
          correction_request_id?: string | null;
        };
        Update: Partial<{
          time_in: string | null;
          time_out: string | null;
          corrected_by: string | null;
          corrected_at: string | null;
          correction_request_id: string | null;
        }>;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_dtr_entries_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "vizserve_pms_users";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_timesheet_weeks: {
        Row: {
          id: string;
          user_id: string;
          /** Always a Monday — a CHECK enforces it, and the function truncates. */
          week_start: string;
          /**
           * Snapshotted at submission, not resolved live through the user.
           * A submitted week is a decision-bearing artefact and has to keep the
           * department it was decided under, the same argument as
           * vizserve_pms_approvals.department_id.
           */
          department_id: string;
          status: VizservePmsTimesheetWeekStatus;
          /** What the person attested to. The reviewer sees live entries. */
          submitted_minutes: number;
          submitted_at: string;
          decision_reason: string | null;
          reviewed_by: string | null;
          reviewed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        // Rows arrive only through vizserve_pms_submit_timesheet_week and change
        // only through vizserve_pms_decide_timesheet_week. There is no INSERT or
        // UPDATE policy, so a status cannot be set directly and an approval
        // cannot be forged without the matching vizserve_pms_approvals row.
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_timesheet_weeks_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "vizserve_pms_users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vizserve_pms_timesheet_weeks_department_id_fkey";
            columns: ["department_id"];
            referencedRelation: "vizserve_pms_departments";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_timesheet_entries: {
        Row: {
          id: string;
          user_id: string;
          task_id: string;
          work_date: string;
          minutes: number;
          note: string | null;
          /**
           * P7-21. Optional wall-clock times on `work_date`, Manila. Both or
           * neither, and when both are set `minutes` is the span between them —
           * three CHECK constraints, so a row cannot contradict itself.
           *
           * Postgres `time` arrives over PostgREST as `HH:MM:SS`; the UI works
           * in `HH:MM` and trims once on the way in.
           */
          started_at: string | null;
          ended_at: string | null;
          created_at: string;
          updated_at: string;
        };
        // task_id is required here and nowhere is it optional. That is the
        // whole feature (docs/09, Amier 33:20) expressed in the type: a call
        // that omits it does not compile, rather than reaching the NOT NULL.
        Insert: {
          id?: string;
          user_id: string;
          task_id: string;
          work_date: string;
          minutes: number;
          note?: string | null;
          started_at?: string | null;
          ended_at?: string | null;
        };
        Update: Partial<{
          task_id: string;
          work_date: string;
          minutes: number;
          note: string | null;
          started_at: string | null;
          ended_at: string | null;
        }>;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_timesheet_entries_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "vizserve_pms_users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vizserve_pms_timesheet_entries_task_id_fkey";
            columns: ["task_id"];
            referencedRelation: "vizserve_pms_tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      vizserve_pms_internal_requests: {
        Row: {
          id: string;
          request_type: VizservePmsInternalRequestType;
          requester_id: string;
          department_id: string;
          status: VizservePmsInternalRequestStatus;
          reason: string;
          start_date: string | null;
          end_date: string | null;
          work_date: string | null;
          correction_at: string | null;
          amount: number | null;
          /** P7-04. Set only on OVERTIME rows; capped at 960 by a CHECK. */
          overtime_minutes: number | null;
          /**
           * P7-12. Required on LEAVE and forbidden on every other type.
           *
           * Nullable here despite being required, because LEAVE rows filed
           * before the list existed have none — the constraint is NOT VALID for
           * exactly that reason, and there is no honest way to backfill a type
           * nobody stated.
           */
          leave_type_id: string | null;
          /** P7-16. LEAVE only, and null on every row written before it. */
          start_half: VizservePmsDayHalf | null;
          end_half: VizservePmsDayHalf | null;
          decision_reason: string | null;
          reviewed_by: string | null;
          reviewed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          request_type: VizservePmsInternalRequestType;
          requester_id: string;
          department_id: string;
          status?: VizservePmsInternalRequestStatus;
          reason: string;
          start_date?: string | null;
          end_date?: string | null;
          work_date?: string | null;
          correction_at?: string | null;
          amount?: number | null;
          overtime_minutes?: number | null;
          leave_type_id?: string | null;
          start_half?: VizservePmsDayHalf | null;
          end_half?: VizservePmsDayHalf | null;
        };
        Update: Partial<{
          status: VizservePmsInternalRequestStatus;
          decision_reason: string | null;
          reviewed_by: string | null;
          reviewed_at: string | null;
        }>;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_internal_requests_requester_id_fkey";
            columns: ["requester_id"];
            referencedRelation: "vizserve_pms_users";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vizserve_pms_internal_requests_department_id_fkey";
            columns: ["department_id"];
            referencedRelation: "vizserve_pms_departments";
            referencedColumns: ["id"];
          },
          /**
           * P7-12 added this FK; nobody added it here, so PostgREST's embedded
           * select `vizserve_pms_leave_types(label)` typed as a
           * `SelectQueryError` and app/(app)/dtr/page.tsx bought its way past it
           * with `as unknown as`. Declaring the relationship is the fix that
           * cast was standing in for.
           */
          {
            foreignKeyName: "vizserve_pms_internal_requests_leave_type_id_fkey";
            columns: ["leave_type_id"];
            referencedRelation: "vizserve_pms_leave_types";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: {
      vizserve_pms_current_role: {
        Args: Record<PropertyKey, never>;
        Returns: VizservePmsUserRole | null;
      };
      vizserve_pms_has_role: {
        Args: { required: VizservePmsUserRole };
        Returns: boolean;
      };
      vizserve_pms_is_admin: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      /**
       * P7-52. True for a user carrying `is_hr`, AND for any admin — the admin
       * branch is why widening a policy from `is_admin()` to this is a strict
       * widening rather than a transfer.
       *
       * Nothing in `app/` should call this over RPC: `canDoHr()` in
       * `lib/auth/authorization.ts` answers the same question from the context
       * already resolved for the request. It is typed here because it is the
       * predicate the policies use, and the types file describes the database.
       */
      vizserve_pms_is_hr: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      vizserve_pms_has_app_access: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      vizserve_pms_managed_department_ids: {
        Args: Record<PropertyKey, never>;
        Returns: string[];
      };
      vizserve_pms_manages_department: {
        Args: { target_department_id: string };
        Returns: boolean;
      };
      vizserve_pms_write_audit_log: {
        Args: {
          p_entity_type: string;
          /**
           * Nullable, and the SQL always was — `vizserve_pms_audit_logs.entity_id`
           * is a plain `uuid` column with no NOT NULL. P7-35 is the first
           * caller to need it: a holiday is identified by its DATE, so there is no
           * uuid to pass, and the date travels in the payload rather than being
           * coerced into something it is not.
           */
          p_entity_id: string | null;
          p_action: string;
          p_actor_id?: string | null;
          p_before?: Json | null;
          p_after?: Json | null;
        };
        Returns: string;
      };
      vizserve_pms_notify: {
        Args: {
          p_user_id: string;
          p_type: VizservePmsNotificationType;
          p_title: string;
          p_body?: string;
          p_entity_type?: string | null;
          p_entity_id?: string | null;
          p_link_path?: string | null;
        };
        Returns: Database["public"]["Tables"]["vizserve_pms_notifications"]["Row"];
      };
      /**
       * P7-10 — the shared out-of-office calendar.
       *
       * Hand-written rather than generated, like everything else in this file:
       * `db:types` needs Docker and a local Supabase, which this machine does
       * not reliably have. Keep it in step with
       * `20260818130000_p7_10_leave_calendar.sql`.
       *
       * NOTE WHAT IS ABSENT: no `reason`, no `id`, no `department_id`. RLS
       * cannot withhold one column, so the function projects only what is safe
       * for everyone to see. Do not widen this signature without widening the
       * SQL, and do not widen the SQL without a reason better than convenience.
       *
       * P7-42 added the halves and `type_label`, and kept it in step with
       * `20260825100000_p7_42_leave_calendar_details.sql`. `type_label` is null
       * in two situations the caller cannot tell apart and must not try to: a
       * row filed before P7-12 had no type at all, and a LABEL_HIDDEN type is
       * withholding one. Both read "On leave". A HIDDEN type does not appear in
       * this result at all unless the caller is its own requester.
       */
      vizserve_pms_leave_calendar: {
        Args: { p_from: string; p_to: string };
        Returns: {
          user_id: string;
          full_name: string;
          start_date: string;
          end_date: string;
          start_half: VizservePmsDayHalf | null;
          end_half: VizservePmsDayHalf | null;
          type_label: string | null;
        }[];
      };
      /**
       * P7-33. Allocated / used / remaining per leave type, for one person in
       * one year.
       *
       * Both arguments default: no `p_user_id` means the caller, no `p_year`
       * means the current year in Manila. SECURITY DEFINER with its own
       * authority check inside — it RAISES for a caller who is not the subject,
       * their department lead, or an admin, rather than returning zeroes.
       */
      vizserve_pms_leave_balance_summary: {
        Args: { p_user_id?: string | null; p_year?: number | null };
        Returns: {
          leave_type_id: string;
          code: string;
          label: string;
          is_active: boolean;
          days_allocated: number;
          days_used: number;
          /** Allocated − used. Goes NEGATIVE on an overdraw; nothing blocks. */
          days_remaining: number;
        }[];
      };
      /**
       * P7-34, filterable since P7-53. MODE A of the leave audit: one row per
       * person per leave type for one year, WITH allocation.
       *
       * Scoped by what the caller LEADS, plus HR and admin (who get everyone),
       * plus THEIR OWN RECORD — that last branch is new in P7-53 and amends
       * D30, which previously gave a member an empty set.
       *
       * ⚠️ EVERY FILTER IS NULL-MEANS-EVERYTHING. Passing `[]` is not "no
       * filter", it is "match nothing", and would render a blank PDF that reads
       * as a broken export — which is why `lib/schemas/leave-report.ts` refuses
       * an empty array rather than passing it through.
       *
       * Includes leavers who took leave in the year, flagged by `is_active`.
       * Their absences are part of the year being audited whether or not they
       * are still on the payroll.
       */
      vizserve_pms_leave_report: {
        Args: {
          p_year?: number | null;
          p_user_ids?: string[] | null;
          p_department_ids?: string[] | null;
          p_leave_type_ids?: string[] | null;
        };
        Returns: {
          user_id: string;
          full_name: string;
          email: string;
          is_active: boolean;
          department_name: string | null;
          leave_type_id: string;
          code: string;
          label: string;
          sort_order: number;
          days_allocated: number;
          days_used: number;
          days_remaining: number;
        }[];
      };
      /**
       * P7-53. MODE B of the leave audit: one row per approved LEAVE request
       * overlapping an arbitrary window.
       *
       * ⚠️ THERE IS NO ALLOCATION COLUMN, and that is the design. Allocation is
       * annual, so a "remaining" figure scoped to March–June would be a lie
       * with a number beside it. Mode A is the only place allocation appears.
       *
       * `days` is counted for the OVERLAP, not for the request: a five-day
       * request half outside the window contributes only its days inside it,
       * and its half-day markers are dropped at whichever end was clipped.
       * `is_clipped` says that happened, so the PDF can mark a row whose day
       * count deliberately disagrees with its printed date range.
       */
      vizserve_pms_leave_taken: {
        Args: {
          p_from: string;
          p_to: string;
          p_user_ids?: string[] | null;
          p_department_ids?: string[] | null;
          p_leave_type_ids?: string[] | null;
        };
        Returns: {
          user_id: string;
          full_name: string;
          email: string;
          is_active: boolean;
          department_name: string | null;
          leave_type_id: string;
          code: string;
          label: string;
          sort_order: number;
          request_id: string;
          /** The request's own dates, whatever the window was. */
          start_date: string;
          end_date: string;
          /** The window-clipped range `days` was actually counted over. */
          counted_from: string;
          counted_to: string;
          start_half: string;
          end_half: string;
          is_clipped: boolean;
          days: number;
        }[];
      };
      vizserve_pms_submit_request: {
        Args: {
          p_slug: string;
          p_payload: Json;
          p_attachments?: Json;
          p_ip?: string | null;
        };
        Returns: Json;
      };
      /**
       * P7-51. The public tracking page, by unguessable token.
       *
       * Returns reference, title, dates and a stage timeline — never the
       * brief, staff names, internal comments or any id. One error shape for
       * every failure, so it cannot be used to probe for valid tokens.
       */
      vizserve_pms_get_request_status: {
        Args: { p_token: string };
        Returns: Json;
      };
      vizserve_pms_get_public_form: {
        Args: { p_slug: string };
        Returns: Json;
      };
      /**
       * P1-15 / P7-66. Logs a submission the SERVER ACTION refused — which
       * `vizserve_pms_submit_request` never sees — and answers whether the
       * sender was already over the hourly cap. `{ "throttled": boolean }`.
       *
       * Service role only; deliberately NOT granted to `anon`, unlike
       * `vizserve_pms_submit_request`. It writes a row keyed by IP and email,
       * so an anonymous caller could use it to throttle somebody else.
       */
      vizserve_pms_record_public_submission_rejection: {
        Args: { p_slug: string; p_ip?: string | null; p_email?: string | null };
        Returns: Json;
      };
      /**
       * P7-66. The ONLY writer of `vizserve_pms_forms.schema`. Stores the blob
       * and projects it into `vizserve_pms_form_fields` in one transaction, so
       * the R5 guard still raises on a renamed `field_key` or a removed field
       * that has answers — and rolls the blob back with it.
       *
       * `returns void`: success is the ABSENCE of an error, never a result to
       * inspect.
       */
      vizserve_pms_save_form_schema: {
        Args: { p_form_id: string; p_schema: Json };
        Returns: undefined;
      };
      vizserve_pms_next_reference_no: {
        Args: { p_form_id: string };
        Returns: string;
      };
      vizserve_pms_redeem_attachments: {
        Args: { p_request_id: string; p_form_id: string; p_attachments: Json };
        Returns: number;
      };
      vizserve_pms_expire_pending_attachments: {
        Args: { p_older_than?: string };
        Returns: { storage_path: string }[];
      };
      vizserve_pms_can_approve: {
        Args: { p_department_id: string };
        Returns: boolean;
      };
      vizserve_pms_punch: {
        Args: { p_direction: string; p_work_date?: string | null };
        Returns: Json;
      };
      vizserve_pms_submit_internal_request: {
        Args: {
          p_request_type: VizservePmsInternalRequestType;
          p_reason: string;
          p_start_date?: string | null;
          p_end_date?: string | null;
          p_work_date?: string | null;
          /** Wall-clock 'HH:MM' on p_work_date; combined with it in Manila. */
          p_correction_time?: string | null;
          p_amount?: number | null;
          /**
           * P7-04. OPTIONAL here because the SQL gives it a default — which
           * means TypeScript will NOT flag a caller that forgets it. An OVERTIME
           * request submitted without it is refused by the shape CHECK at
           * runtime, so the guard is a db test, not the compiler.
           */
          p_overtime_minutes?: number | null;
          /**
           * P7-12. Same silent-failure shape as `p_overtime_minutes` above, and
           * the same answer: optional to the compiler, required by the function
           * for LEAVE, covered by a db test rather than by types.
           */
          p_leave_type_id?: string | null;
          /**
           * ⚠️ P7-16. OPTIONAL to the compiler, because the SQL parameters have
           * defaults — so leaving them out is not a type error, it just files
           * every leave request as a whole span. `tests/db/phase5.test.ts` is the
           * guard, not tsc.
           */
          p_start_half?: VizservePmsDayHalf | null;
          p_end_half?: VizservePmsDayHalf | null;
        };
        Returns: Json;
      };
      vizserve_pms_decide_internal_request: {
        Args: {
          p_id: string;
          p_decision: VizservePmsApprovalDecision;
          p_reason?: string | null;
        };
        Returns: Json;
      };
      vizserve_pms_create_personal_task: {
        /**
         * P7-01. No department and no assignee: both come from the caller's own
         * user row inside the function, so they are not the client's to send.
         */
        Args: {
          p_title: string;
          p_description?: string;
          p_due_date?: string | null;
          p_list_id?: string | null;
          /** P7-11. Present here where department and assignee are not: how
           *  urgent your own work is IS yours to decide. */
          p_priority?: VizservePmsTaskPriority | null;
        };
        Returns: Json;
      };
      vizserve_pms_submit_timesheet_week: {
        /** Any day in the week works — the function truncates to the Monday. */
        Args: { p_week_start: string };
        Returns: Json;
      };
      vizserve_pms_decide_timesheet_week: {
        /** 'approved' or 'returned'. 'rejected' is refused by the function. */
        Args: {
          p_id: string;
          p_decision: VizservePmsApprovalDecision;
          p_reason?: string | null;
        };
        Returns: Json;
      };
      vizserve_pms_timesheet_week_locked: {
        Args: { p_user_id: string; p_work_date: string };
        Returns: boolean;
      };
      vizserve_pms_record_decision: {
        Args: {
          p_entity_type: string;
          p_entity_id: string;
          p_department_id: string | null;
          p_decision: VizservePmsApprovalDecision;
          p_reason?: string | null;
        };
        Returns: string;
      };
      vizserve_pms_approvable_department_ids: {
        Args: Record<PropertyKey, never>;
        Returns: string[];
      };
      vizserve_pms_manages_department_for: {
        Args: { p_user_id: string; p_department_id: string };
        Returns: boolean;
      };
      vizserve_pms_department_capacity: {
        Args: { p_department_id: string; p_target_date?: string | null };
        Returns: {
          user_id: string;
          full_name: string;
          role: VizservePmsUserRole;
          open_count: number;
          due_before: number;
          overdue_count: number;
          next_due_dates: string[];
        }[];
      };
      vizserve_pms_approve_request: {
        Args: {
          p_request_id: string;
          p_assignee_id: string;
          p_qa_assignee_id: string | null;
          p_approved_target_date?: string | null;
          p_title?: string | null;
          p_description?: string | null;
          p_list_id?: string | null;
          /**
           * P7-11. THE ONLY MOMENT a client task can be given a priority: this
           * function is the statement that creates the task row, so there is no
           * earlier point at which anyone — least of all the client — could
           * have set one.
           */
          p_priority?: VizservePmsTaskPriority | null;
        };
        Returns: Json;
      };
      vizserve_pms_decide_request: {
        Args: {
          p_request_id: string;
          p_decision: VizservePmsApprovalDecision;
          p_reason: string;
        };
        Returns: Json;
      };
      /** The ONLY way a task changes status. See the Update type above. */
      vizserve_pms_transition_task: {
        Args: {
          p_task_id: string;
          p_to_status: VizservePmsTaskStatus;
          p_comment?: string | null;
        };
        Returns: Json;
      };
      vizserve_pms_force_task_status: {
        Args: { p_task_id: string; p_to_status: VizservePmsTaskStatus; p_reason: string };
        Returns: Json;
      };
      vizserve_pms_create_task: {
        Args: {
          p_department_id: string;
          p_title: string;
          p_description?: string;
          p_assignee_id?: string | null;
          p_qa_assignee_id?: string | null;
          p_due_date?: string | null;
          p_list_id?: string | null;
          /**
           * P7-11. OPTIONAL, because it has a SQL default — so TypeScript will
           * NOT flag a call site that forgets it, and a forgotten priority
           * lands as null rather than as an error. The db suite is what covers
           * it. Same silent-failure shape as `p_overtime_minutes`.
           */
          p_priority?: VizservePmsTaskPriority | null;
        };
        Returns: Json;
      };
      vizserve_pms_is_on_task: {
        /** P7-13. PIC, QA reviewer, or on the assignees table. Not "may see it". */
        Args: { p_task_id: string; p_user_id: string };
        Returns: boolean;
      };
      /**
       * P7-19 — deleting an internal task.
       *
       * There is no DELETE policy on `vizserve_pms_tasks` and there must not be:
       * a policy would be a second route in that skips the audit row and the
       * request_id guard. These three functions are the only door.
       */
      vizserve_pms_can_delete_task: {
        Args: { p_task_id: string };
        Returns: boolean;
      };
      vizserve_pms_task_delete_impact: {
        /** Returns `{ ok, title, subtasks, tracked_minutes, comments, attachments }`, or `{ ok: false, reason }`. */
        Args: { p_task_id: string };
        Returns: Json;
      };
      vizserve_pms_delete_task: {
        /** Hard-deletes an internal task and its subtree. Refuses request-backed work. */
        Args: { p_task_id: string };
        Returns: Json;
      };
      vizserve_pms_add_task_assignee: {
        Args: { p_task_id: string; p_user_id: string };
        Returns: Json;
      };
      vizserve_pms_remove_task_assignee: {
        Args: { p_task_id: string; p_user_id: string };
        Returns: Json;
      };
      /**
       * P7-15. Minutes logged per task, summed inside a SECURITY DEFINER.
       *
       * NOT a plain sum on the entries table: that table's policy is per-person,
       * so summing it client-side shows each viewer only their own hours and
       * calls it the task total.
       */
      vizserve_pms_task_time_tracked: {
        Args: { p_task_ids: string[] };
        Returns: { task_id: string; minutes: number }[];
      };
      /**
       * P7-59 — the request's BRIEF for anyone holding a seat on the task, with
       * the client's identity left out. `Returns` is `unknown` on purpose: it is
       * a `jsonb` payload and the shape lives in `taskRequestBriefSchema`, which
       * parses it. A hand-written type here would be a second copy to drift.
       */
      vizserve_pms_task_request_brief: {
        Args: { p_task_id: string };
        Returns: unknown;
      };
      /** P7-59 — the storage path of one of that request's attachments. */
      vizserve_pms_task_request_attachment_path: {
        Args: { p_task_id: string; p_attachment_id: string };
        Returns: string | null;
      };
      vizserve_pms_task_waiting_duration: {
        Args: { p_task_id: string };
        Returns: string;
      };
      vizserve_pms_add_business_days: {
        Args: { p_from: string; p_days: number };
        Returns: string;
      };
      /** Returns the RAW token once. Service role only — never to a browser. */
      vizserve_pms_issue_approval_token: {
        Args: { p_task_id: string; p_purpose?: VizservePmsTokenPurpose };
        Returns: Json;
      };
      vizserve_pms_get_approval_page: {
        Args: { p_token: string };
        Returns: Json;
      };
      vizserve_pms_record_client_decision: {
        Args: {
          p_token: string;
          p_decision: VizservePmsClientDecision;
          p_comment?: string | null;
          p_approver_name?: string | null;
          p_ip?: string | null;
          p_user_agent?: string | null;
        };
        Returns: Json;
      };
      vizserve_pms_auto_complete_approvals: {
        Args: Record<PropertyKey, never>;
        Returns: { task_id: string; reference_no: string | null; requester_email: string | null }[];
      };
      vizserve_pms_claim_approval_reminders: {
        Args: { p_max?: number };
        Returns: {
          task_id: string;
          reference_no: string | null;
          requester_email: string | null;
          requester_name: string | null;
          title: string;
          auto_complete_at: string;
          reminder_number: number;
        }[];
      };
      vizserve_pms_submit_feedback: {
        Args: { p_token: string; p_rating: number; p_comment?: string | null };
        Returns: Json;
      };
    };
    Enums: {
      vizserve_pms_user_role: VizservePmsUserRole;
      vizserve_pms_notification_type: VizservePmsNotificationType;
      vizserve_pms_field_type: VizservePmsFieldType;
      vizserve_pms_request_status: VizservePmsRequestStatus;
      vizserve_pms_approval_decision: VizservePmsApprovalDecision;
      vizserve_pms_task_status: VizservePmsTaskStatus;
      vizserve_pms_task_priority: VizservePmsTaskPriority;
      vizserve_pms_client_decision: VizservePmsClientDecision;
      vizserve_pms_token_purpose: VizservePmsTokenPurpose;
      vizserve_pms_internal_request_type: VizservePmsInternalRequestType;
      vizserve_pms_internal_request_status: VizservePmsInternalRequestStatus;
      vizserve_pms_timesheet_week_status: VizservePmsTimesheetWeekStatus;
      vizserve_pms_gender: VizservePmsGender;
      vizserve_pms_event_category: VizservePmsEventCategory;
    };
    CompositeTypes: Record<never, never>;
  };
};

/** Convenience row aliases. */
export type DepartmentRow = Database["public"]["Tables"]["vizserve_pms_departments"]["Row"];
export type UserRow = Database["public"]["Tables"]["vizserve_pms_users"]["Row"];
export type NotificationRow = Database["public"]["Tables"]["vizserve_pms_notifications"]["Row"];
export type DtrEntryRow = Database["public"]["Tables"]["vizserve_pms_dtr_entries"]["Row"];
export type InternalRequestRow =
  Database["public"]["Tables"]["vizserve_pms_internal_requests"]["Row"];
export type LeaveTypeRow = Database["public"]["Tables"]["vizserve_pms_leave_types"]["Row"];
export type EventRow = Database["public"]["Tables"]["vizserve_pms_events"]["Row"];
export type LeaveBalanceRow =
  Database["public"]["Tables"]["vizserve_pms_leave_balances"]["Row"];
/** One line of the P7-33 summary: a type, what was allocated, and what is left. */
export type LeaveBalanceSummaryRow =
  Database["public"]["Functions"]["vizserve_pms_leave_balance_summary"]["Returns"][number];
/** One line of the P7-34 annual audit (Mode A). Carries allocation. */
export type LeaveReportRpcRow =
  Database["public"]["Functions"]["vizserve_pms_leave_report"]["Returns"][number];
/** One leave request inside a P7-53 window (Mode B). Carries no allocation. */
export type LeaveTakenRpcRow =
  Database["public"]["Functions"]["vizserve_pms_leave_taken"]["Returns"][number];
export type TimesheetEntryRow =
  Database["public"]["Tables"]["vizserve_pms_timesheet_entries"]["Row"];
export type TaskCommentRow =
  Database["public"]["Tables"]["vizserve_pms_task_comments"]["Row"];
export type TimesheetWeekRow =
  Database["public"]["Tables"]["vizserve_pms_timesheet_weeks"]["Row"];
