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
  | "client_decision";

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
          title: string;
          description: string;
          status: VizservePmsTaskStatus;
          assignee_id: string | null;
          qa_assignee_id: string | null;
          due_date: string | null;
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
          resolution: string | null;
          output_link: string | null;
          list_id: string | null;
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
      /** The legal-transition table as data. Mirrored in lib/schemas/tasks.ts. */
      vizserve_pms_task_transitions: {
        Row: {
          from_status: VizservePmsTaskStatus;
          to_status: VizservePmsTaskStatus;
          actor: string;
          required_field: string | null;
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
        };
        Returns: Json;
      };
      vizserve_pms_task_waiting_duration: {
        Args: { p_task_id: string };
        Returns: string;
      };
    };
    Enums: {
      vizserve_pms_user_role: VizservePmsUserRole;
      vizserve_pms_notification_type: VizservePmsNotificationType;
      vizserve_pms_field_type: VizservePmsFieldType;
      vizserve_pms_request_status: VizservePmsRequestStatus;
      vizserve_pms_approval_decision: VizservePmsApprovalDecision;
      vizserve_pms_task_status: VizservePmsTaskStatus;
    };
    CompositeTypes: Record<never, never>;
  };
};

/** Convenience row aliases. */
export type DepartmentRow = Database["public"]["Tables"]["vizserve_pms_departments"]["Row"];
export type UserRow = Database["public"]["Tables"]["vizserve_pms_users"]["Row"];
export type NotificationRow = Database["public"]["Tables"]["vizserve_pms_notifications"]["Row"];
