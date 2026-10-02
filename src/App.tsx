import { useState } from 'react';
import { Toast, VerticalNavigation } from '@capra/core';
import { Book, DatabaseOutlined, HomeOutlined } from '@capra/icons';
import { DatasetsPage } from './DatasetsPage';
import type { HostTheme } from './host-theme';
import { OverviewPage } from './OverviewPage';

type Page = 'overview' | 'datasets';

function App({ theme }: { theme: HostTheme }) {
  const [page, setPage] = useState<Page>('overview');

  return (
    <div className="app-shell">
      <VerticalNavigation aria-label="App navigation">
        <VerticalNavigation.ItemList>
          <VerticalNavigation.Item icon={<HomeOutlined />} label="Overview" isActive={page === 'overview'} onClick={() => setPage('overview')} />
          <VerticalNavigation.Item icon={<DatabaseOutlined />} label="Datasets" isActive={page === 'datasets'} onClick={() => setPage('datasets')} />
        </VerticalNavigation.ItemList>
        <VerticalNavigation.Footer>
          <VerticalNavigation.Item
            icon={<Book />}
            label="Documentation"
            href="https://docs.cribl.io/search/datatypes/#v1-v2"
            target="_blank"
            rel="noopener noreferrer"
          />
        </VerticalNavigation.Footer>
      </VerticalNavigation>
      {/* Overview remounts on each visit so its numbers are fresh. */}
      {page === 'overview' && (
        <main className="app-main">
          <OverviewPage theme={theme} onOpenDatasets={() => setPage('datasets')} />
        </main>
      )}
      {/* Datasets stays mounted while hidden, so sample analyses and running migrations survive a visit to Overview. */}
      <main className="app-main" hidden={page !== 'datasets'}>
        <DatasetsPage theme={theme} />
      </main>
      <Toast.Provider />
    </div>
  );
}

export default App;
