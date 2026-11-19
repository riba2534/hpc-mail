-- 升级后仅保留本地提码，管理员仍可在设置中重新启用 AI 兜底。
UPDATE settings
SET value = json_set(value, '$.aiEnabled', json('false'))
WHERE key = 'code_extract'
  AND CASE WHEN json_valid(value) THEN json_type(value, '$.aiEnabled') = 'true' ELSE 0 END;
