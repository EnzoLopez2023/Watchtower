import { Box, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';

const WATCHTOWER_ICON = '/watchtower-icon-1024.png';

interface WatchtowerBrandProps {
  iconSize?: number;
  textSx?: SxProps<Theme>;
}

export default function WatchtowerBrand({ iconSize = 28, textSx }: WatchtowerBrandProps) {
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
      <Box
        component="img"
        src={WATCHTOWER_ICON}
        alt=""
        aria-hidden
        width={iconSize}
        height={iconSize}
        sx={{ display: 'block', flexShrink: 0, borderRadius: '22%' }}
      />
      <Typography component="span" sx={textSx}>
        Watchtower
      </Typography>
    </Box>
  );
}
