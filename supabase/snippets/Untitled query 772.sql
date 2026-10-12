-- Our trigger log (stage 2)
select action, actor_role, actor_id, changes
  from audit_log order by created_at;

-- supa_audit
select table_name, op, auth_role, auth_uid, record, old_record
  from audit.record_version order by id;
