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
    };
    Enums: {
      vizserve_pms_user_role: VizservePmsUserRole;
      vizserve_pms_notification_type: VizservePmsNotificationType;
      vizserve_pms_field_type: VizservePmsFieldType;
      vizserve_pms_request_status: VizservePmsRequestStatus;
    };
    CompositeTypes: Record<never, never>;
  };
};

/** Convenience row aliases. */
export type DepartmentRow = Database["public"]["Tables"]["vizserve_pms_departments"]["Row"];
export type UserRow = Database["public"]["Tables"]["vizserve_pms_users"]["Row"];
export type NotificationRow = Database["public"]["Tables"]["vizserve_pms_notifications"]["Row"];
