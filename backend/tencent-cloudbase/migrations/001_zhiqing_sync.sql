CREATE TABLE IF NOT EXISTS public.zhiqing_sync (
  id text PRIMARY KEY,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  revision bigint NOT NULL,
  client_updated_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

ALTER TABLE public.zhiqing_sync ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.zhiqing_sync_put(
  p_ciphertext text,
  p_iv text,
  p_base_revision bigint,
  p_client_updated_at bigint
)
RETURNS TABLE(ok boolean, conflict boolean, revision bigint, updated_at bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  current_row public.zhiqing_sync%ROWTYPE;
  next_updated_at bigint;
BEGIN
  SELECT * INTO current_row
  FROM public.zhiqing_sync
  WHERE id = 'main'
  FOR UPDATE;

  next_updated_at := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;

  IF NOT FOUND THEN
    IF p_base_revision <> 0 THEN
      RETURN QUERY SELECT false, true, 0::bigint, next_updated_at;
      RETURN;
    END IF;
    INSERT INTO public.zhiqing_sync
      (id, ciphertext, iv, revision, client_updated_at, updated_at)
    VALUES
      ('main', p_ciphertext, p_iv, 1, p_client_updated_at, next_updated_at);
    RETURN QUERY SELECT true, false, 1::bigint, next_updated_at;
    RETURN;
  END IF;

  IF current_row.revision <> p_base_revision THEN
    RETURN QUERY SELECT false, true, current_row.revision, current_row.updated_at;
    RETURN;
  END IF;

  UPDATE public.zhiqing_sync
  SET ciphertext = p_ciphertext,
      iv = p_iv,
      revision = current_row.revision + 1,
      client_updated_at = p_client_updated_at,
      updated_at = next_updated_at
  WHERE id = 'main';

  RETURN QUERY SELECT true, false, current_row.revision + 1, next_updated_at;
END;
$$;
