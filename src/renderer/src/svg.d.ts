/**
 * A picture file brought into the page as an address that holds the whole of it (`data:`). The
 * page may load pictures from such addresses, and from none of its own (see the policy in index.html).
 */
declare module '*.svg?inline' {
  const address: string
  export default address
}
