import { describe, it, expect } from 'vitest';
import {
    getMissingRecommendedPackages,
    isPackageSourceConfigured,
    RECOMMENDED_PI_PACKAGES,
} from '../../../pi/recommendedPackages';

describe('recommendedPackages', () => {
    it('detects configured package by substring', () => {
        expect(isPackageSourceConfigured(['npm:@narumitw/pi-plan-mode'], 'pi-plan-mode')).toBe(true);
        expect(isPackageSourceConfigured(['npm:pi-mcp-adapter'], 'pi-plan-mode')).toBe(false);
    });

    it('lists missing when not in settings', () => {
        const missing = getMissingRecommendedPackages([], [], 'pi');
        expect(missing.map((p) => p.id)).toEqual(RECOMMENDED_PI_PACKAGES.map((p) => p.id));
    });

    it('treats /plan command as plan package present', () => {
        const missing = getMissingRecommendedPackages([], ['plan'], 'pi');
        expect(missing.some((p) => p.id === 'pi-plan-mode')).toBe(false);
        expect(missing.some((p) => p.id === 'pi-mcp-adapter')).toBe(true);
    });

    it('recommends nothing under omp (pi extensions do not load there)', () => {
        expect(getMissingRecommendedPackages([], [], 'omp')).toEqual([]);
    });
});
