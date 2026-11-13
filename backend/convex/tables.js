// GENERATED from the original Postgres schema (backend/src/db/schema.sql history).
// Shared by Convex functions (convex/*.js) and the Node API (src/db/*.js).
// Column types: int | text | bool | ts (ISO string) | date (YYYY-MM-DD) | json (stored as a JSON string) | text[]
// default '$now' means the current timestamp. ref.onDelete drives cascades in convex/db.js.
export const TABLES = {
  "users": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "email": {
        "type": "text",
        "notNull": true
      },
      "password_hash": {
        "type": "text",
        "notNull": true
      },
      "role": {
        "type": "text",
        "notNull": true,
        "default": "agent",
        "enum": [
          "admin",
          "agent"
        ]
      },
      "avatar_url": {
        "type": "text"
      },
      "phone": {
        "type": "text"
      },
      "job_title": {
        "type": "text"
      },
      "time_zone": {
        "type": "text",
        "default": "UTC"
      },
      "signature": {
        "type": "text"
      },
      "is_active": {
        "type": "bool",
        "notNull": true,
        "default": true
      },
      "last_login_at": {
        "type": "ts"
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "updated_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "role_id": {
        "type": "int",
        "ref": {
          "table": "roles",
          "onDelete": "SET NULL"
        }
      },
      "agent_status_id": {
        "type": "int",
        "ref": {
          "table": "agent_statuses",
          "onDelete": "SET NULL"
        }
      }
    },
    "unique": [
      [
        "email"
      ]
    ],
    "checks": [],
    "touchUpdatedAt": true
  },
  "groups": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "description": {
        "type": "text"
      },
      "escalate_to_user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "auto_assign": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "updated_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [
      [
        "name"
      ]
    ],
    "checks": [],
    "touchUpdatedAt": true
  },
  "group_members": {
    "columns": {
      "group_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "groups",
          "onDelete": "CASCADE"
        }
      },
      "user_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "users",
          "onDelete": "CASCADE"
        }
      },
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true,
        "synthetic": true
      }
    },
    "unique": [
      [
        "group_id",
        "user_id"
      ]
    ],
    "checks": []
  },
  "companies": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "domains": {
        "type": "text[]",
        "notNull": true,
        "default": []
      },
      "description": {
        "type": "text"
      },
      "notes": {
        "type": "text"
      },
      "industry": {
        "type": "text"
      },
      "account_tier": {
        "type": "text",
        "default": "standard"
      },
      "health_score": {
        "type": "text",
        "default": "neutral",
        "enum": [
          "at_risk",
          "neutral",
          "happy"
        ]
      },
      "renewal_date": {
        "type": "date"
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "updated_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "custom_fields": {
        "type": "json",
        "notNull": true,
        "default": {}
      }
    },
    "unique": [
      [
        "name"
      ]
    ],
    "checks": [],
    "touchUpdatedAt": true
  },
  "contacts": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "email": {
        "type": "text"
      },
      "phone": {
        "type": "text"
      },
      "mobile": {
        "type": "text"
      },
      "company_id": {
        "type": "int",
        "ref": {
          "table": "companies",
          "onDelete": "SET NULL"
        }
      },
      "job_title": {
        "type": "text"
      },
      "address": {
        "type": "text"
      },
      "time_zone": {
        "type": "text",
        "default": "UTC"
      },
      "language": {
        "type": "text",
        "default": "en"
      },
      "tags": {
        "type": "text[]",
        "notNull": true,
        "default": []
      },
      "description": {
        "type": "text"
      },
      "password_hash": {
        "type": "text"
      },
      "is_verified": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "is_blocked": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "avatar_url": {
        "type": "text"
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "updated_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "custom_fields": {
        "type": "json",
        "notNull": true,
        "default": {}
      }
    },
    "unique": [
      [
        "email"
      ]
    ],
    "checks": [],
    "touchUpdatedAt": true
  },
  "sla_policies": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "description": {
        "type": "text"
      },
      "is_default": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "is_active": {
        "type": "bool",
        "notNull": true,
        "default": true
      },
      "position": {
        "type": "int",
        "notNull": true,
        "default": 1
      },
      "conditions": {
        "type": "json",
        "notNull": true,
        "default": {}
      },
      "targets": {
        "type": "json",
        "notNull": true,
        "default": {}
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "updated_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": [],
    "touchUpdatedAt": true
  },
  "tickets": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "subject": {
        "type": "text",
        "notNull": true
      },
      "description": {
        "type": "text",
        "notNull": true,
        "default": ""
      },
      "status": {
        "type": "text",
        "notNull": true,
        "default": "open"
      },
      "priority": {
        "type": "text",
        "notNull": true,
        "default": "low",
        "enum": [
          "low",
          "medium",
          "high",
          "urgent"
        ]
      },
      "type": {
        "type": "text",
        "enum": [
          "question",
          "incident",
          "problem",
          "feature_request",
          "refund",
          "other"
        ]
      },
      "source": {
        "type": "text",
        "notNull": true,
        "default": "portal",
        "enum": [
          "email",
          "portal",
          "phone",
          "chat",
          "social",
          "agent"
        ]
      },
      "requester_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "contacts",
          "onDelete": "CASCADE"
        }
      },
      "responder_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "group_id": {
        "type": "int",
        "ref": {
          "table": "groups",
          "onDelete": "SET NULL"
        }
      },
      "company_id": {
        "type": "int",
        "ref": {
          "table": "companies",
          "onDelete": "SET NULL"
        }
      },
      "tags": {
        "type": "text[]",
        "notNull": true,
        "default": []
      },
      "cc_emails": {
        "type": "text[]",
        "notNull": true,
        "default": []
      },
      "custom_fields": {
        "type": "json",
        "notNull": true,
        "default": {}
      },
      "sla_policy_id": {
        "type": "int",
        "ref": {
          "table": "sla_policies",
          "onDelete": "SET NULL"
        }
      },
      "fr_due_by": {
        "type": "ts"
      },
      "due_by": {
        "type": "ts"
      },
      "first_responded_at": {
        "type": "ts"
      },
      "resolved_at": {
        "type": "ts"
      },
      "closed_at": {
        "type": "ts"
      },
      "is_escalated": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "fr_escalated": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "spam": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "deleted": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "merged_into_ticket_id": {
        "type": "int",
        "ref": {
          "table": "tickets",
          "onDelete": "SET NULL"
        }
      },
      "created_by_user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "updated_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "product_id": {
        "type": "int",
        "ref": {
          "table": "products",
          "onDelete": "SET NULL"
        }
      },
      "parent_ticket_id": {
        "type": "int",
        "ref": {
          "table": "tickets",
          "onDelete": "SET NULL"
        }
      },
      "archived": {
        "type": "bool",
        "notNull": true,
        "default": false
      }
    },
    "unique": [],
    "checks": [],
    "touchUpdatedAt": true
  },
  "ticket_watchers": {
    "columns": {
      "ticket_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "tickets",
          "onDelete": "CASCADE"
        }
      },
      "user_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "users",
          "onDelete": "CASCADE"
        }
      },
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true,
        "synthetic": true
      }
    },
    "unique": [
      [
        "ticket_id",
        "user_id"
      ]
    ],
    "checks": []
  },
  "conversations": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "ticket_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "tickets",
          "onDelete": "CASCADE"
        }
      },
      "user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "contact_id": {
        "type": "int",
        "ref": {
          "table": "contacts",
          "onDelete": "SET NULL"
        }
      },
      "kind": {
        "type": "text",
        "notNull": true,
        "default": "reply",
        "enum": [
          "reply",
          "note",
          "forward",
          "system"
        ]
      },
      "is_private": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "body": {
        "type": "text",
        "notNull": true
      },
      "source": {
        "type": "text",
        "notNull": true,
        "default": "portal"
      },
      "to_emails": {
        "type": "text[]",
        "notNull": true,
        "default": []
      },
      "cc_emails": {
        "type": "text[]",
        "notNull": true,
        "default": []
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "attachments": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "ticket_id": {
        "type": "int",
        "ref": {
          "table": "tickets",
          "onDelete": "CASCADE"
        }
      },
      "conversation_id": {
        "type": "int",
        "ref": {
          "table": "conversations",
          "onDelete": "CASCADE"
        }
      },
      "article_id": {
        "type": "int"
      },
      "file_name": {
        "type": "text",
        "notNull": true
      },
      "content_type": {
        "type": "text"
      },
      "size": {
        "type": "int",
        "notNull": true,
        "default": 0
      },
      "path": {
        "type": "text",
        "notNull": true
      },
      "uploaded_by_user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "uploaded_by_contact_id": {
        "type": "int",
        "ref": {
          "table": "contacts",
          "onDelete": "SET NULL"
        }
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "ticket_activities": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "ticket_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "tickets",
          "onDelete": "CASCADE"
        }
      },
      "user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "contact_id": {
        "type": "int",
        "ref": {
          "table": "contacts",
          "onDelete": "SET NULL"
        }
      },
      "actor_label": {
        "type": "text"
      },
      "action": {
        "type": "text",
        "notNull": true
      },
      "details": {
        "type": "json",
        "notNull": true,
        "default": {}
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "tags": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "color": {
        "type": "text",
        "default": "#6366f1"
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [
      [
        "name"
      ]
    ],
    "checks": []
  },
  "canned_responses": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "title": {
        "type": "text",
        "notNull": true
      },
      "content": {
        "type": "text",
        "notNull": true
      },
      "folder": {
        "type": "text",
        "notNull": true,
        "default": "General"
      },
      "visibility": {
        "type": "text",
        "notNull": true,
        "default": "all",
        "enum": [
          "all",
          "personal",
          "group"
        ]
      },
      "group_id": {
        "type": "int",
        "ref": {
          "table": "groups",
          "onDelete": "SET NULL"
        }
      },
      "user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "usage_count": {
        "type": "int",
        "notNull": true,
        "default": 0
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "updated_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": [],
    "touchUpdatedAt": true
  },
  "kb_categories": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "description": {
        "type": "text"
      },
      "position": {
        "type": "int",
        "notNull": true,
        "default": 1
      },
      "visible_in_portal": {
        "type": "bool",
        "notNull": true,
        "default": true
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "kb_folders": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "category_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "kb_categories",
          "onDelete": "CASCADE"
        }
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "description": {
        "type": "text"
      },
      "visibility": {
        "type": "text",
        "notNull": true,
        "default": "public",
        "enum": [
          "public",
          "logged_in",
          "agents"
        ]
      },
      "position": {
        "type": "int",
        "notNull": true,
        "default": 1
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "kb_articles": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "folder_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "kb_folders",
          "onDelete": "CASCADE"
        }
      },
      "title": {
        "type": "text",
        "notNull": true
      },
      "slug": {
        "type": "text",
        "notNull": true
      },
      "body": {
        "type": "text",
        "notNull": true,
        "default": ""
      },
      "status": {
        "type": "text",
        "notNull": true,
        "default": "draft",
        "enum": [
          "draft",
          "published"
        ]
      },
      "author_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "tags": {
        "type": "text[]",
        "notNull": true,
        "default": []
      },
      "keywords": {
        "type": "text[]",
        "notNull": true,
        "default": []
      },
      "views": {
        "type": "int",
        "notNull": true,
        "default": 0
      },
      "thumbs_up": {
        "type": "int",
        "notNull": true,
        "default": 0
      },
      "thumbs_down": {
        "type": "int",
        "notNull": true,
        "default": 0
      },
      "published_at": {
        "type": "ts"
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "updated_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [
      [
        "slug"
      ]
    ],
    "checks": [],
    "touchUpdatedAt": true
  },
  "automations": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "description": {
        "type": "text"
      },
      "event": {
        "type": "text",
        "notNull": true,
        "enum": [
          "ticket_created",
          "ticket_updated",
          "time_trigger"
        ]
      },
      "conditions": {
        "type": "json",
        "notNull": true,
        "default": {
          "match": "all",
          "rules": []
        }
      },
      "actions": {
        "type": "json",
        "notNull": true,
        "default": []
      },
      "is_active": {
        "type": "bool",
        "notNull": true,
        "default": true
      },
      "position": {
        "type": "int",
        "notNull": true,
        "default": 1
      },
      "run_count": {
        "type": "int",
        "notNull": true,
        "default": 0
      },
      "last_run_at": {
        "type": "ts"
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "updated_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": [],
    "touchUpdatedAt": true
  },
  "time_entries": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "ticket_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "tickets",
          "onDelete": "CASCADE"
        }
      },
      "user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "minutes": {
        "type": "int",
        "notNull": true
      },
      "note": {
        "type": "text"
      },
      "billable": {
        "type": "bool",
        "notNull": true,
        "default": true
      },
      "started_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "satisfaction_ratings": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "ticket_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "tickets",
          "onDelete": "CASCADE"
        }
      },
      "contact_id": {
        "type": "int",
        "ref": {
          "table": "contacts",
          "onDelete": "SET NULL"
        }
      },
      "agent_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "rating": {
        "type": "int",
        "notNull": true
      },
      "feedback": {
        "type": "text"
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "survey_id": {
        "type": "int",
        "ref": {
          "table": "surveys",
          "onDelete": "SET NULL"
        }
      },
      "answer": {
        "type": "text"
      }
    },
    "unique": [
      [
        "ticket_id"
      ]
    ],
    "checks": []
  },
  "notifications": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "CASCADE"
        }
      },
      "contact_id": {
        "type": "int",
        "ref": {
          "table": "contacts",
          "onDelete": "CASCADE"
        }
      },
      "type": {
        "type": "text",
        "notNull": true
      },
      "title": {
        "type": "text",
        "notNull": true
      },
      "body": {
        "type": "text"
      },
      "link": {
        "type": "text"
      },
      "is_read": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "saved_views": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "CASCADE"
        }
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "filters": {
        "type": "json",
        "notNull": true,
        "default": {}
      },
      "visibility": {
        "type": "text",
        "notNull": true,
        "default": "private",
        "enum": [
          "private",
          "all_agents"
        ]
      },
      "position": {
        "type": "int",
        "notNull": true,
        "default": 1
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "business_hours": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "description": {
        "type": "text"
      },
      "time_zone": {
        "type": "text",
        "notNull": true,
        "default": "UTC"
      },
      "is_default": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "always_open": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "schedule": {
        "type": "json",
        "notNull": true,
        "default": {}
      },
      "holidays": {
        "type": "json",
        "notNull": true,
        "default": []
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "ticket_fields": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "label": {
        "type": "text",
        "notNull": true
      },
      "field_type": {
        "type": "text",
        "notNull": true,
        "default": "text",
        "enum": [
          "text",
          "textarea",
          "number",
          "decimal",
          "dropdown",
          "dependent",
          "checkbox",
          "date"
        ]
      },
      "options": {
        "type": "json",
        "notNull": true,
        "default": []
      },
      "required_for_agents": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "required_for_customers": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "visible_to_customers": {
        "type": "bool",
        "notNull": true,
        "default": true
      },
      "position": {
        "type": "int",
        "notNull": true,
        "default": 1
      },
      "is_default": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "parent_field": {
        "type": "text"
      }
    },
    "unique": [
      [
        "name"
      ]
    ],
    "checks": []
  },
  "settings": {
    "columns": {
      "key": {
        "type": "text",
        "notNull": true
      },
      "value": {
        "type": "json",
        "notNull": true,
        "default": {}
      },
      "updated_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true,
        "synthetic": true
      }
    },
    "unique": [
      [
        "key"
      ]
    ],
    "checks": []
  },
  "roles": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "description": {
        "type": "text"
      },
      "is_default": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "privileges": {
        "type": "text[]",
        "notNull": true,
        "default": []
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [
      [
        "name"
      ]
    ],
    "checks": []
  },
  "agent_statuses": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "emoji": {
        "type": "text"
      },
      "accepts_tickets": {
        "type": "bool",
        "notNull": true,
        "default": true
      },
      "is_default": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "position": {
        "type": "int",
        "notNull": true,
        "default": 1
      }
    },
    "unique": [
      [
        "name"
      ]
    ],
    "checks": []
  },
  "ticket_statuses": {
    "columns": {
      "key": {
        "type": "text",
        "notNull": true
      },
      "label": {
        "type": "text",
        "notNull": true
      },
      "customer_label": {
        "type": "text",
        "notNull": true
      },
      "stops_sla": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "is_default": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "position": {
        "type": "int",
        "notNull": true,
        "default": 1
      },
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true,
        "synthetic": true
      }
    },
    "unique": [
      [
        "key"
      ]
    ],
    "checks": []
  },
  "products": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "description": {
        "type": "text"
      },
      "support_email": {
        "type": "text"
      },
      "portal_name": {
        "type": "text"
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [
      [
        "name"
      ]
    ],
    "checks": []
  },
  "ticket_links": {
    "columns": {
      "ticket_a": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "tickets",
          "onDelete": "CASCADE"
        }
      },
      "ticket_b": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "tickets",
          "onDelete": "CASCADE"
        }
      },
      "created_by_user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true,
        "synthetic": true
      }
    },
    "unique": [
      [
        "ticket_a",
        "ticket_b"
      ]
    ],
    "checks": [
      "CHECK (ticket_a < ticket_b)"
    ]
  },
  "ticket_todos": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "ticket_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "tickets",
          "onDelete": "CASCADE"
        }
      },
      "user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "title": {
        "type": "text",
        "notNull": true
      },
      "is_done": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "due_at": {
        "type": "ts"
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "ticket_threads": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "ticket_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "tickets",
          "onDelete": "CASCADE"
        }
      },
      "title": {
        "type": "text",
        "notNull": true
      },
      "created_by_user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "ticket_thread_messages": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "thread_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "ticket_threads",
          "onDelete": "CASCADE"
        }
      },
      "user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "body": {
        "type": "text",
        "notNull": true
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "ticket_mentions": {
    "columns": {
      "ticket_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "tickets",
          "onDelete": "CASCADE"
        }
      },
      "user_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "users",
          "onDelete": "CASCADE"
        }
      },
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true,
        "synthetic": true
      }
    },
    "unique": [
      [
        "ticket_id",
        "user_id"
      ]
    ],
    "checks": []
  },
  "scenarios": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "description": {
        "type": "text"
      },
      "visibility": {
        "type": "text",
        "notNull": true,
        "default": "all",
        "enum": [
          "all",
          "group",
          "personal"
        ]
      },
      "group_id": {
        "type": "int",
        "ref": {
          "table": "groups",
          "onDelete": "SET NULL"
        }
      },
      "user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "actions": {
        "type": "json",
        "notNull": true,
        "default": []
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "ticket_templates": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "description": {
        "type": "text"
      },
      "parent_template_id": {
        "type": "int",
        "ref": {
          "table": "ticket_templates",
          "onDelete": "CASCADE"
        }
      },
      "subject": {
        "type": "text"
      },
      "body": {
        "type": "text"
      },
      "priority": {
        "type": "text"
      },
      "status": {
        "type": "text"
      },
      "type": {
        "type": "text"
      },
      "group_id": {
        "type": "int",
        "ref": {
          "table": "groups",
          "onDelete": "SET NULL"
        }
      },
      "responder_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "product_id": {
        "type": "int",
        "ref": {
          "table": "products",
          "onDelete": "SET NULL"
        }
      },
      "tags": {
        "type": "text[]",
        "notNull": true,
        "default": []
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "ticket_forms": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "description": {
        "type": "text"
      },
      "type": {
        "type": "text"
      },
      "product_id": {
        "type": "int",
        "ref": {
          "table": "products",
          "onDelete": "SET NULL"
        }
      },
      "group_id": {
        "type": "int",
        "ref": {
          "table": "groups",
          "onDelete": "SET NULL"
        }
      },
      "field_names": {
        "type": "text[]",
        "notNull": true,
        "default": []
      },
      "is_active": {
        "type": "bool",
        "notNull": true,
        "default": true
      },
      "position": {
        "type": "int",
        "notNull": true,
        "default": 1
      }
    },
    "unique": [],
    "checks": []
  },
  "entity_fields": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "entity": {
        "type": "text",
        "notNull": true,
        "enum": [
          "contact",
          "company"
        ]
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "label": {
        "type": "text",
        "notNull": true
      },
      "field_type": {
        "type": "text",
        "notNull": true,
        "default": "text",
        "enum": [
          "text",
          "textarea",
          "number",
          "dropdown",
          "checkbox",
          "date"
        ]
      },
      "options": {
        "type": "json",
        "notNull": true,
        "default": []
      },
      "position": {
        "type": "int",
        "notNull": true,
        "default": 1
      }
    },
    "unique": [
      [
        "entity",
        "name"
      ]
    ],
    "checks": []
  },
  "surveys": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "question": {
        "type": "text",
        "notNull": true,
        "default": "How would you rate your experience?"
      },
      "labels": {
        "type": "json",
        "notNull": true,
        "default": [
          "Very poor",
          "Poor",
          "Okay",
          "Good",
          "Excellent"
        ]
      },
      "is_active": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "email_notifications": {
    "columns": {
      "key": {
        "type": "text",
        "notNull": true
      },
      "label": {
        "type": "text",
        "notNull": true
      },
      "audience": {
        "type": "text",
        "notNull": true,
        "enum": [
          "requester",
          "agent"
        ]
      },
      "is_enabled": {
        "type": "bool",
        "notNull": true,
        "default": true
      },
      "subject": {
        "type": "text",
        "notNull": true
      },
      "body": {
        "type": "text",
        "notNull": true
      },
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true,
        "synthetic": true
      }
    },
    "unique": [
      [
        "key"
      ]
    ],
    "checks": []
  },
  "email_outbox": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "ticket_id": {
        "type": "int",
        "ref": {
          "table": "tickets",
          "onDelete": "SET NULL"
        }
      },
      "to_email": {
        "type": "text",
        "notNull": true
      },
      "subject": {
        "type": "text",
        "notNull": true
      },
      "body": {
        "type": "text",
        "notNull": true
      },
      "status": {
        "type": "text",
        "notNull": true,
        "default": "logged",
        "enum": [
          "logged",
          "sent",
          "failed"
        ]
      },
      "error": {
        "type": "text"
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "mailboxes": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "email": {
        "type": "text",
        "notNull": true
      },
      "group_id": {
        "type": "int",
        "ref": {
          "table": "groups",
          "onDelete": "SET NULL"
        }
      },
      "product_id": {
        "type": "int",
        "ref": {
          "table": "products",
          "onDelete": "SET NULL"
        }
      },
      "is_default": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [
      [
        "email"
      ]
    ],
    "checks": []
  },
  "forum_categories": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "description": {
        "type": "text"
      },
      "position": {
        "type": "int",
        "notNull": true,
        "default": 1
      }
    },
    "unique": [],
    "checks": []
  },
  "forums": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "category_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "forum_categories",
          "onDelete": "CASCADE"
        }
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "description": {
        "type": "text"
      },
      "forum_type": {
        "type": "text",
        "notNull": true,
        "default": "questions",
        "enum": [
          "questions",
          "ideas",
          "problems",
          "announcements"
        ]
      },
      "visibility": {
        "type": "text",
        "notNull": true,
        "default": "public",
        "enum": [
          "public",
          "logged_in",
          "agents"
        ]
      },
      "position": {
        "type": "int",
        "notNull": true,
        "default": 1
      }
    },
    "unique": [],
    "checks": []
  },
  "forum_topics": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "forum_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "forums",
          "onDelete": "CASCADE"
        }
      },
      "title": {
        "type": "text",
        "notNull": true
      },
      "body": {
        "type": "text",
        "notNull": true
      },
      "user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "contact_id": {
        "type": "int",
        "ref": {
          "table": "contacts",
          "onDelete": "SET NULL"
        }
      },
      "status": {
        "type": "text",
        "notNull": true,
        "default": "published",
        "enum": [
          "published",
          "waiting",
          "spam"
        ]
      },
      "is_locked": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "is_pinned": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "stamp": {
        "type": "text"
      },
      "views": {
        "type": "int",
        "notNull": true,
        "default": 0
      },
      "ticket_id": {
        "type": "int",
        "ref": {
          "table": "tickets",
          "onDelete": "SET NULL"
        }
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      },
      "updated_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "forum_posts": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "topic_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "forum_topics",
          "onDelete": "CASCADE"
        }
      },
      "body": {
        "type": "text",
        "notNull": true
      },
      "user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "contact_id": {
        "type": "int",
        "ref": {
          "table": "contacts",
          "onDelete": "SET NULL"
        }
      },
      "status": {
        "type": "text",
        "notNull": true,
        "default": "published",
        "enum": [
          "published",
          "waiting",
          "spam"
        ]
      },
      "is_answer": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "forum_votes": {
    "columns": {
      "topic_id": {
        "type": "int",
        "notNull": true,
        "ref": {
          "table": "forum_topics",
          "onDelete": "CASCADE"
        }
      },
      "voter": {
        "type": "text",
        "notNull": true
      },
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true,
        "synthetic": true
      }
    },
    "unique": [
      [
        "topic_id",
        "voter"
      ]
    ],
    "checks": []
  },
  "saved_reports": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "CASCADE"
        }
      },
      "name": {
        "type": "text",
        "notNull": true
      },
      "folder": {
        "type": "text"
      },
      "config": {
        "type": "json",
        "notNull": true,
        "default": {}
      },
      "is_shared": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "is_favorite": {
        "type": "bool",
        "notNull": true,
        "default": false
      },
      "schedule": {
        "type": "text",
        "enum": [
          "daily",
          "weekly"
        ]
      },
      "recipients": {
        "type": "text[]",
        "notNull": true,
        "default": []
      },
      "last_sent_at": {
        "type": "ts"
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  },
  "audit_log": {
    "columns": {
      "id": {
        "type": "int",
        "notNull": true,
        "serial": true
      },
      "user_id": {
        "type": "int",
        "ref": {
          "table": "users",
          "onDelete": "SET NULL"
        }
      },
      "actor_label": {
        "type": "text"
      },
      "method": {
        "type": "text",
        "notNull": true
      },
      "path": {
        "type": "text",
        "notNull": true
      },
      "status": {
        "type": "int"
      },
      "created_at": {
        "type": "ts",
        "notNull": true,
        "default": "$now"
      }
    },
    "unique": [],
    "checks": []
  }
};

// Extra single-column indexes for hot lookups (besides id, foreign keys and unique columns).
const EXTRA_INDEXES = { tickets: ['status'], conversations: ['ticket_id'], notifications: ['user_id'] };

// Columns that get an `idx_<col>` Convex index: id, every foreign key, every unique column.
export function indexedFields(table) {
  const t = TABLES[table];
  const set = new Set(['id']);
  for (const [col, c] of Object.entries(t.columns)) if (c.ref) set.add(col);
  for (const u of t.unique) for (const col of u) set.add(col);
  for (const col of EXTRA_INDEXES[table] || []) set.add(col);
  return [...set];
}

// [childTable, column, onDelete] for every foreign key pointing at `table`.
export function referencesTo(table) {
  const out = [];
  for (const [name, t] of Object.entries(TABLES)) {
    for (const [col, c] of Object.entries(t.columns)) if (c.ref && c.ref.table === table) out.push([name, col, c.ref.onDelete]);
  }
  return out;
}
