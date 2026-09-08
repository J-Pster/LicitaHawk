import { SortOrder } from "../common/query-validation";

export interface SavedSearchCriteria {
  uf?: string[];
  modalidade?: string[];
  keyword?: string;
  municipio?: string;
  situacao?: string[];
  valorMin?: number;
  valorMax?: number;
  dataInicial?: string;
  dataFinal?: string;
  sort?: SortOrder;
}

export interface SavedSearch {
  account_id: string;
  saved_search_id: string;
  name: string;
  criteria: SavedSearchCriteria;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
}
