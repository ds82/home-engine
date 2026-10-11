// Home Assistant wire types shared across the adapter.

export interface HaContext {
  id: string;
  parent_id: string | null;
  user_id: string | null;
}

/** A full state object, as in `get_states` and `state_changed` events. */
export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
  context: HaContext;
}
