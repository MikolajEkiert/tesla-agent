import React, { createContext, useContext, useEffect, useState } from "react";
import { Language, loadLanguage, saveLanguage, t as translate, TranslationKey } from "./i18n";

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
  /** False until the stored/detected preference has loaded — gate first render on this. */
  ready: boolean;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("en");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadLanguage().then((loaded) => {
      setLanguageState(loaded);
      setReady(true);
    });
  }, []);

  const setLanguage = (next: Language) => {
    setLanguageState(next);
    saveLanguage(next);
  };

  return (
    <LanguageContext.Provider
      value={{ language, setLanguage, t: (key, vars) => translate(language, key, vars), ready }}
    >
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  return ctx;
}
