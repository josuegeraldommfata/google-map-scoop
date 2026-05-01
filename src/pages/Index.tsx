import { useState, useCallback, useEffect, useRef } from "react";
import { SearchForm } from "@/components/SearchForm";
import { StatsCards } from "@/components/StatsCards";
import { LeadsTable } from "@/components/LeadsTable";
import { SearchHistoryPanel } from "@/components/SearchHistoryPanel";
import { Lead, SearchQuery, SearchHistory } from "@/types/lead";
import { Crosshair, Zap, Terminal as TerminalIcon } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function Index() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [history, setHistory] = useState<SearchHistory[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [logs, setLogs] = useState<{msg: string, timestamp: string}[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  const hotLeads = leads.filter(l => l.type === 'hot').length;
  const coldLeads = leads.filter(l => l.type === 'cold').length;

  // Auto-scroll para os logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Conexão de Logs em tempo real
  useEffect(() => {
    const LOG_URL = '/api/logs';

    const eventSource = new EventSource(LOG_URL);
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setLogs(prev => [...prev.slice(-49), data]); // Mantém os últimos 50
    };
    return () => eventSource.close();
  }, []);

  // Detecta se está no Vercel para usar a URL da Render, senão usa local
  const API_URL = '';

  const handleSearch = useCallback(async (query: SearchQuery) => {
    setIsSearching(true);
    setLogs([]); // Limpa logs para nova busca
    try {
      const res = await fetch(`${API_URL}/api/scrape-leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Erro desconhecido' }));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const newLeads: Lead[] = (data?.leads || []) as Lead[];

      if (newLeads.length === 0) {
        toast.warning('Nenhum lead encontrado. Tente outro nicho ou cidade.');
      } else {
        toast.success(`${newLeads.length} leads capturados com sucesso!`);
      }

      setLeads(prev => {
        const existingIds = new Set(prev.map(l => l.name + l.city));
        const unique = newLeads.filter(l => !existingIds.has(l.name + l.city));
        return [...prev, ...unique];
      });

      const hot = newLeads.filter(l => l.type === 'hot').length;
      const cold = newLeads.filter(l => l.type === 'cold').length;

      setHistory(prev => [{
        id: Math.random().toString(36).substring(2),
        query,
        leadsFound: newLeads.length,
        hotLeads: hot,
        coldLeads: cold,
        executedAt: new Date().toISOString(),
      }, ...prev]);
    } catch (e: any) {
      console.error('Erro na busca:', e);
      toast.error(`Erro: ${e?.message || 'Tente novamente'}`);
    } finally {
      setIsSearching(false);
    }
  }, []);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10 glow-primary">
              <Crosshair className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-heading font-bold text-foreground tracking-tight">Leads Hunter</h1>
              <p className="text-[11px] text-muted-foreground -mt-0.5">Prospecção inteligente via Google Maps</p>
            </div>
          </div>
          {leads.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Zap className="w-4 h-4 text-primary" />
              <span className="font-medium text-foreground">{leads.length}</span> leads capturados
            </div>
          )}
        </div>
      </header>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <div className="grid grid-cols-1 xl:grid-cols-4 gap-6">
          {/* Coluna Central - Busca */}
          <div className="xl:col-span-2 space-y-6">
            <SearchForm onSearch={handleSearch} isSearching={isSearching} />
            {leads.length > 0 && <StatsCards total={leads.length} hot={hotLeads} cold={coldLeads} />}
          </div>

          {/* Coluna Direita - Console e Histórico */}
          <div className="xl:col-span-2 space-y-6">
            {/* Console de Logs */}
            <Card className="bg-[#0c0c0c] border-[#1a1a1a] p-4 font-mono text-[11px]">
              <div className="flex items-center gap-2 mb-3 text-primary">
                <TerminalIcon className="w-4 h-4" />
                <span className="font-bold uppercase tracking-widest">Console de Scraping</span>
                {isSearching && <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse ml-auto" />}
              </div>
              <ScrollArea className="h-[215px] pr-4">
                {logs.length === 0 ? (
                  <div className="text-muted-foreground italic h-full flex items-center justify-center opacity-50">
                    Aguardando início da prospecção...
                  </div>
                ) : (
                  <div className="space-y-1">
                    {logs.map((log, i) => (
                      <div key={i} className="flex gap-3 border-l border-white/5 pl-3">
                        <span className="text-white/20 whitespace-nowrap">
                          {new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}
                        </span>
                        <span className={log.msg.startsWith('[✓]') ? "text-green-400" : "text-blue-300"}>
                          {log.msg}
                        </span>
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </div>
                )}
              </ScrollArea>
            </Card>

            {/* Painel de Missões (Histórico Turbinado) */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 px-1">
                <Zap className="w-4 h-4 text-primary" />
                <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">Histórico de Missões</h2>
              </div>
              
              <div className="space-y-3">
                {history.length === 0 ? (
                  <div className="h-[200px] rounded-xl border border-dashed border-white/5 flex flex-col items-center justify-center text-muted-foreground opacity-30 italic text-xs">
                    Nenhuma missão registrada no banco...
                  </div>
                ) : (
                  history.map((item) => {
                    const hotEfficiency = Math.round((item.hotLeads / item.leadsFound) * 100) || 0;
                    return (
                      <Card key={item.id} className="bg-card/30 border-white/5 p-4 hover:border-primary/30 transition-all cursor-default group overflow-hidden relative">
                        {/* Background Decorativo */}
                        <div className="absolute -right-4 -top-4 opacity-[0.03] group-hover:opacity-[0.08] transition-opacity">
                          <Crosshair className="w-24 h-24 text-primary" />
                        </div>
                        
                        <div className="flex justify-between items-start mb-3 relative z-10">
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-[10px] font-mono text-primary/60">MISSION_ID: {item.id.toUpperCase()}</span>
                              <span className="h-1 w-1 rounded-full bg-green-500 animate-pulse" />
                            </div>
                            <h3 className="text-sm font-bold text-foreground capitalize">
                              {item.query.niche} em {item.query.cities[0]}
                            </h3>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] text-muted-foreground mb-1">
                              {new Date(item.executedAt).toLocaleDateString()}
                            </div>
                            <div className="flex items-center gap-1 text-xs font-bold text-primary">
                              <Zap className="w-3 h-3" />
                              {item.leadsFound} LEADS
                            </div>
                          </div>
                        </div>

                        {/* Barra de Eficiência (Hot Leads) */}
                        <div className="space-y-1.5 relative z-10">
                          <div className="flex justify-between text-[10px] uppercase font-bold tracking-wider">
                            <span className="text-muted-foreground">Hot Lead Index</span>
                            <span className="text-primary">{hotEfficiency}%</span>
                          </div>
                          <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                            <div 
                              className="h-full bg-gradient-to-r from-primary/50 to-primary glow-primary rounded-full transition-all duration-1000"
                              style={{ width: `${hotEfficiency}%` }}
                            />
                          </div>
                        </div>

                        <div className="mt-4 flex gap-2 relative z-10">
                          <div className="px-2 py-1 rounded bg-orange-500/10 border border-orange-500/20 text-[9px] font-bold text-orange-400 uppercase">
                            🔥 {item.hotLeads} Quentes
                          </div>
                          <div className="px-2 py-1 rounded bg-blue-500/10 border border-blue-500/20 text-[9px] font-bold text-blue-400 uppercase">
                            ❄️ {item.coldLeads} Frios
                          </div>
                        </div>
                      </Card>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>

        {leads.length > 0 && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <LeadsTable leads={leads} />
          </div>
        )}

        {leads.length === 0 && !isSearching && (
          <div className="text-center py-20 animate-slide-up bg-card/10 rounded-3xl border border-white/5">
            <div className="inline-flex p-4 rounded-2xl bg-primary/5 mb-4">
              <Crosshair className="w-12 h-12 text-primary/40" />
            </div>
            <h2 className="text-xl font-heading font-semibold text-foreground mb-2">
              Pronto para caçar leads?
            </h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Preencha o formulário e acompanhe o robô em tempo real no console lateral.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

