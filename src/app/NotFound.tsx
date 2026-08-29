import { Box, Button } from '@mui/material';
import { useLocation, useNavigate } from 'react-router-dom';
import PageHero from '../components/PageHero';
import { EmptyState } from '../components/StateBlocks';
import { pageShellSx } from '../theme/controls';
import { DEFAULT_PATH } from './navigation';

export default function NotFound() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <Box sx={pageShellSx()}>
      <PageHero
        compact
        eyebrow="Watchtower"
        title="No such page"
        accentPhrase="No such"
        subtitle="The address you opened does not match any Watchtower view."
      />
      <EmptyState
        title={`Nothing is mapped to ${location.pathname}`}
        detail="Pick a section from the navigation, or go back to System Status."
        action={
          <Button variant="contained" onClick={() => void navigate(DEFAULT_PATH)}>
            Go to System Status
          </Button>
        }
      />
    </Box>
  );
}
