/** How deep a leftover staging directory is verified.
 *  The janitor will not delete or queue a dir it could not see to the bottom.
 *  A recovery must inspect at least this far before it may discard. Executors
 *  default `listTree` to 6, which stops short of this. */
export const JANITOR_LIST_DEPTH = 10;
