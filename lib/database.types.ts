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
export type VizservePmsInternalRequestType =
  | "LEAVE"
  | "NO_TIME_IN"
  | "NO_TIME_OUT"
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
          sla_days: number;
          /** Business days the client gets at Gate 3 before auto-completion. */
          client_approval_days: number;
          default_list_id: string | null;
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
          sla_days?: number;
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
          sla_days: number;
          client_approval_days: number;
          default_list_id: string | null;
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
          created_by?: string | null;
        };
        Update: Partial<{
          name: string;
          description: string;
          is_active: boolean;
          sort_order: number;
        }>;
        Relationships: [
          {
            foreignKeyName: "vizserve_pms_lists_department_id_fkey";
            columns: ["department_id"];
            referencedRelation: "vizserve_pms_departments";
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
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          code: string;
          label: string;
          is_active?: boolean;
          sort_order?: number;
        };
        Update: Partial<{
          code: string;
          label: string;
          is_active: boolean;
          sort_order: number;
        }>;
        Relationships: [];
      };
      /** The legal-transition table as data. Mirrored in lib/schemas/tasks.ts. */
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
        };
        Update: Partial<{
          task_id: string;
          work_date: string;
          minutes: number;
          note: string | null;
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
          p_entity_id: string;
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
       * cannot withhold one column, so the function projects only the four
       * that are safe for everyone to see. Do not widen this signature without
       * widening the SQL, and do not widen the SQL without a reason better
       * than convenience.
       */
      vizserve_pms_leave_calendar: {
        Args: { p_from: string; p_to: string };
        Returns: {
          user_id: string;
          full_name: string;
          start_date: string;
          end_date: string;
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
      vizserve_pms_get_public_form: {
        Args: { p_slug: string };
        Returns: Json;
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
export type TimesheetEntryRow =
  Database["public"]["Tables"]["vizserve_pms_timesheet_entries"]["Row"];
export type TaskCommentRow =
  Database["public"]["Tables"]["vizserve_pms_task_comments"]["Row"];
export type TimesheetWeekRow =
  Database["public"]["Tables"]["vizserve_pms_timesheet_weeks"]["Row"];
