/**
 * Performs a natural sort on an array of objects or strings.
 * @param {Array} array The array to sort
 * @param {Function} keyExtractor Optional function to extract the sort key from an object
 * @returns {Array} The sorted array
 */
export function naturalSort(array, keyExtractor = (item) => item) {
    if (!array || !Array.isArray(array)) return [];
    
    return [...array].sort((a, b) => {
        const aKey = String(keyExtractor(a));
        const bKey = String(keyExtractor(b));
        return aKey.localeCompare(bKey, undefined, { numeric: true, sensitivity: 'base' });
    });
}
