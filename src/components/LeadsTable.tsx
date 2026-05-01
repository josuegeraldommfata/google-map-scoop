import { useState, useMemo } from "react";
import { Lead } from "@/types/lead";
import { getWhatsAppLink, leadsToCSV, downloadFile, buildPitchMessage } from "@/lib/leadGenerator";
import {
  Flame, Snowflake, MessageCircle, ExternalLink, Star, Search,
  Download, ChevronLeft, ChevronRight, Filter, Globe, Phone, Instagram
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface Props {
  leads: Lead[];
}

const PAGE_SIZE = 10;

// ─── Especialidades jurídicas ─────────────────────────────────────────────────

const LEGAL_NICHES = ['advogado', 'advocacia', 'advogados', 'juridico', 'jurídico', 'direito', 'lawyer'];

const LEGAL_SPECIALTIES: { keywords: string[]; label: string; color: string }[] = [
  { keywords: ['previdenciári', 'previdenci', 'inss', 'aposentadori'], label: 'Previdenciário', color: 'bg-purple-500/15 text-purple-400 border-purple-500/30' },
  { keywords: ['trabalhist', 'trabalhador', 'clt', 'empregado', 'demissão'], label: 'Trabalhista', color: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  { keywords: ['criminal', 'penal', 'crime', 'defesa criminal'], label: 'Criminal', color: 'bg-red-500/15 text-red-400 border-red-500/30' },
  { keywords: ['família', 'familia', 'divórcio', 'divorcio', 'guarda', 'aliment', 'herança', 'inventári'], label: 'Família', color: 'bg-pink-500/15 text-pink-400 border-pink-500/30' },
  { keywords: ['civil', 'cível', 'civel', 'contrato', 'indeniz'], label: 'Civil', color: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' },
  { keywords: ['imobiliári', 'imóveis', 'imoveis', 'locação', 'locacao', 'condomíni'], label: 'Imobiliário', color: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  { keywords: ['tributári', 'tributario', 'fiscal', 'imposto', 'tax'], label: 'Tributário', color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  { keywords: ['empresarial', 'empresa', 'societári', 'sociedade', 'startup'], label: 'Empresarial', color: 'bg-orange-500/15 text-orange-400 border-orange-500/30' },
  { keywords: ['consumidor', 'cdc', 'recall', 'fornecedor'], label: 'Consumidor', color: 'bg-teal-500/15 text-teal-400 border-teal-500/30' },
  { keywords: ['digital', 'tecnologia', 'lgpd', 'dados', 'internet'], label: 'Digital', color: 'bg-violet-500/15 text-violet-400 border-violet-500/30' },
  { keywords: ['ambiental', 'meio ambiente', 'agro', 'rural'], label: 'Ambiental', color: 'bg-green-500/15 text-green-400 border-green-500/30' },
  { keywords: ['médico', 'medico', 'saúde', 'hospital', 'erro médico'], label: 'Médico', color: 'bg-rose-500/15 text-rose-400 border-rose-500/30' },
];

function extractLegalSpecialties(name: string, niche: string): { label: string; color: string }[] {
  const nicheL = niche.toLowerCase();
  const isLegal = LEGAL_NICHES.some(n => nicheL.includes(n));
  if (!isLegal) return [];

  const nameL = name.toLowerCase();
  const found: { label: string; color: string }[] = [];

  for (const spec of LEGAL_SPECIALTIES) {
    if (spec.keywords.some(kw => nameL.includes(kw))) {
      found.push({ label: spec.label, color: spec.color });
      if (found.length >= 3) break; // máximo 3 badges
    }
  }
  return found;
}

export function LeadsTable({ leads }: Props) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<'all' | 'hot' | 'cold'>('all');
  const [sortBy, setSortBy] = useState<'name' | 'rating' | 'reviews'>('rating');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    let result = leads;
    if (filter !== 'all') result = result.filter(l => l.type === filter);
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(l =>
        l.name.toLowerCase().includes(s) ||
        l.city.toLowerCase().includes(s) ||
        l.phone.includes(s)
      );
    }
    result = [...result].sort((a, b) => {
      if (sortBy === 'rating') return b.rating - a.rating;
      if (sortBy === 'reviews') return b.reviewCount - a.reviewCount;
      return a.name.localeCompare(b.name);
    });
    return result;
  }, [leads, filter, search, sortBy]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleExportCSV = () => {
    downloadFile(leadsToCSV(filtered), `leads-hunter-${Date.now()}.csv`, 'text/csv');
  };

  return (
    <div className="rounded-xl border border-border bg-card animate-slide-up">
      {/* Toolbar */}
      <div className="p-4 border-b border-border flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              placeholder="Buscar lead..."
              className="pl-9 w-56 bg-muted border-border h-9 text-sm"
            />
          </div>
          <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
            {([['all', 'Todos', Filter], ['hot', 'Quentes', Flame], ['cold', 'Frios', Snowflake]] as const).map(([key, label, Icon]) => (
              <button
                key={key}
                onClick={() => { setFilter(key); setPage(1); }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  filter === key
                    ? key === 'hot' ? 'bg-hot/20 text-hot' : key === 'cold' ? 'bg-cold/20 text-cold' : 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as any)}
            className="h-9 rounded-md border border-border bg-muted px-2 text-xs text-foreground"
          >
            <option value="rating">Ordenar: Avaliação</option>
            <option value="reviews">Ordenar: Avaliações</option>
            <option value="name">Ordenar: Nome</option>
          </select>
          <Button variant="outline" size="sm" onClick={handleExportCSV} className="gap-1.5 text-xs">
            <Download className="w-3.5 h-3.5" />
            CSV
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th className="text-left p-3 font-medium">Empresa</th>
              <th className="text-left p-3 font-medium hidden lg:table-cell">Endereço</th>
              <th className="text-left p-3 font-medium">Contato</th>
              <th className="text-center p-3 font-medium">Avaliação</th>
              <th className="text-center p-3 font-medium">Tipo</th>
              <th className="text-center p-3 font-medium">Ações</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map(lead => (
              <tr key={lead.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                <td className="p-3">
                  <p className="font-medium text-foreground">{lead.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{lead.niche} • {lead.city}</p>
                  {/* Especialidades jurídicas */}
                  {(() => {
                    const specs = extractLegalSpecialties(lead.name, lead.niche);
                    if (!specs.length) return null;
                    return (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {specs.map(s => (
                          <span
                            key={s.label}
                            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${s.color}`}
                          >
                            {s.label}
                          </span>
                        ))}
                      </div>
                    );
                  })()}
                </td>
                <td className="p-3 hidden lg:table-cell">
                  <p className="text-xs text-muted-foreground max-w-xs truncate">{lead.address}</p>
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-1.5 text-xs text-foreground">
                    <Phone className="w-3.5 h-3.5 text-muted-foreground" />
                    {lead.phone}
                  </div>
                  {lead.website && (
                    <div className="flex items-center gap-1.5 text-xs text-cold mt-1">
                      <Globe className="w-3.5 h-3.5" />
                      <span className="truncate max-w-[140px]">{lead.website.replace('https://', '')}</span>
                    </div>
                  )}
                  {lead.instagram && (
                    <div className="flex items-center gap-1.5 text-xs text-pink-400 mt-1">
                      <Instagram className="w-3.5 h-3.5" />
                      <span className="truncate max-w-[140px]">{lead.instagram}</span>
                    </div>
                  )}
                </td>
                <td className="p-3 text-center">
                  {lead.rating > 0 ? (
                    <div className="flex items-center justify-center gap-1">
                      <Star className="w-3.5 h-3.5 text-yellow-500 fill-yellow-500" />
                      <span className="font-medium text-foreground">{lead.rating}</span>
                      <span className="text-xs text-muted-foreground">({lead.reviewCount})</span>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="p-3 text-center">
                  {lead.type === 'hot' ? (
                    <Badge className="bg-hot/15 text-hot border-hot/30 gap-1 text-xs">
                      <Flame className="w-3 h-3" />
                      Quente
                    </Badge>
                  ) : (
                    <Badge className="bg-cold/15 text-cold border-cold/30 gap-1 text-xs">
                      <Snowflake className="w-3 h-3" />
                      Frio
                    </Badge>
                  )}
                </td>
                <td className="p-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    {lead.whatsapp && (
                      <a
                        href={getWhatsAppLink(lead.whatsapp, buildPitchMessage(lead))}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded-md bg-success/10 text-success hover:bg-success/20 transition-colors"
                        title="Abrir WhatsApp com mensagem persuasiva pronta"
                      >
                        <MessageCircle className="w-4 h-4" />
                      </a>
                    )}
                    {lead.instagram && (
                      <a
                        href={`https://instagram.com/${lead.instagram.replace(/^@/, '')}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded-md bg-pink-500/10 text-pink-400 hover:bg-pink-500/20 transition-colors"
                        title="Abrir Instagram"
                      >
                        <Instagram className="w-4 h-4" />
                      </a>
                    )}
                    {lead.website && (
                      <a
                        href={lead.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded-md bg-cold/10 text-cold hover:bg-cold/20 transition-colors"
                        title="Abrir Website"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    )}
                    {!lead.website && (
                      <span className="text-[10px] text-hot font-medium bg-hot/10 px-2 py-0.5 rounded-full">
                        🎯 Oportunidade
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="p-3 border-t border-border flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {filtered.length} leads encontrados
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={page === 1}
              onClick={() => setPage(p => p - 1)}
              className="h-8 w-8 p-0"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <span className="text-xs text-muted-foreground px-2">
              {page} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page === totalPages}
              onClick={() => setPage(p => p + 1)}
              className="h-8 w-8 p-0"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
